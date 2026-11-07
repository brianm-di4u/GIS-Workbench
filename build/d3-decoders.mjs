// Draco and Basis Universal decoder blocks for glTF / 3D Tiles (REQ-FMT-34, S-47), from three.js's
// examples/jsm/libs (Apache-2.0). The Basis transcoder's Emscripten embind glue builds two kinds of
// function with the Function constructor (invokers for bound C++ functions, and emval method
// callers); the page's CSP has no 'unsafe-eval', and the blob: worker it runs in inherits that
// CSP. Both are replaced with closures that do the same work (Emscripten's DYNAMIC_EXECUTION=0
// behaviour). A three.js upgrade that changes the glue fails the build here instead of at runtime.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INVOKER = 'let[args,invokerFnBody]=createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync);args.push(invokerFnBody);var invokerFn=newFunc(Function,args)(...closureArgs);';
const INVOKER_NO_EVAL =
  'var invokerFn=function(...a){if(a.length!==argCount-2){throwBindingError("function "+humanName+" called with "+a.length+" arguments, expected "+(argCount-2))}' +
  'var destructors=needsDestructorStack?[]:null;var thisWired;var wired=[];if(isClassMethodFunc){thisWired=argTypes[1]["toWireType"](destructors,this)}' +
  'for(var i=0;i<argCount-2;++i){wired.push(argTypes[i+2]["toWireType"](destructors,a[i]))}' +
  'var rv=isClassMethodFunc?cppInvokerFunc(cppTargetFunc,thisWired,...wired):cppInvokerFunc(cppTargetFunc,...wired);' +
  'if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var pw=i===1?thisWired:wired[i-2];if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(pw)}}}' +
  'if(returns){return argTypes[0]["fromWireType"](rv)}};';
const CALLER = 'var invokerFunction=newFunc(Function,params)(...args);';
const CALLER_NO_EVAL =
  'var invokerFunction=function(obj,func,destructorsRef,argsPtr){var a=[];var off=0;for(var i=0;i<argCount;++i){a.push(types[i].readValueFromPointer(argsPtr+off));off+=types[i]["argPackAdvance"]}' +
  'var rv=kind===1?new func(...a):kind===0?func.call(obj,...a):func.call(...a);if(!retType.isVoid){return emval_returnValue(retType,destructorsRef,rv)}};';

// Newer Emscripten (the ktx2-encoder build of the Basis encoder): createJsInvoker returns the
// constructed function, and emval invokers are built from a captures object.
const INVOKER2 = 'let invokerFactory=createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync);var invokerFn=invokerFactory(...closureArgs);';
const CALLER2 = 'var invokerFunction=new Function(Object.keys(captures),functionBody)(...Object.values(captures));';
const CALLER2_NO_EVAL =
  'var invokerFunction=function(handle,methodName,destructorsRef,args){var v=argFromPtr.map((f,i)=>f(args+i*GenericWireTypeSize)),r;switch(kind){case 0:r=Emval.toValue(handle)(...v);break;case 2:r=new(Emval.toValue(handle))(...v);break;case 3:r=v[v.length-1];break;case 1:r=Emval.toValue(handle)[getStringOrSymbol(methodName)](...v)}if(!retType.isVoid){return emval_returnValue(toReturnWire,destructorsRef,r)}};';

/**
 * Emscripten embind glue with its Function-constructor sites replaced by closures (two glue
 * generations are known). Throws when a site is not found exactly once, or one is left.
 */
export function embindNoEval(text, label = 'embind glue') {
  const variants = [
    [
      [INVOKER, INVOKER_NO_EVAL],
      [CALLER, CALLER_NO_EVAL],
    ],
    [
      [INVOKER2, INVOKER_NO_EVAL],
      [CALLER2, CALLER2_NO_EVAL],
      // createJsInvoker is no longer called; its Function constructor goes too.
      ['return new Function(args1,invokerFnBody)', 'throw new Error("embind: dynamic invokers are disabled (CSP)")'],
    ],
  ];
  const v = variants.find((pairs) => pairs.every(([a]) => text.split(a).length === 2));
  if (!v) throw new Error(`${label}: the embind Function-constructor sites were not found (Emscripten upgraded? update build/d3-decoders.mjs)`);
  for (const [a, b] of v) text = text.replace(a, b);
  if (/newFunc\(Function|new Function\(/.test(text)) throw new Error(`${label} still builds functions from strings`);
  return text;
}

/** basis_transcoder.js with the two Function-constructor sites replaced. */
export const basisGlue = (text) => embindNoEval(text, 'basis_transcoder.js');

/** The four decoder blocks' bytes: {name: Buffer}. */
export function d3DecoderBlocks(root) {
  const libs = join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs');
  return {
    'wasm-draco': readFileSync(join(libs, 'draco', 'draco_decoder.wasm')),
    'data-draco-glue': readFileSync(join(libs, 'draco', 'draco_wasm_wrapper.js')),
    'wasm-basis': readFileSync(join(libs, 'basis', 'basis_transcoder.wasm')),
    'data-basis-glue': Buffer.from(basisGlue(readFileSync(join(libs, 'basis', 'basis_transcoder.js'), 'utf8'))),
  };
}
