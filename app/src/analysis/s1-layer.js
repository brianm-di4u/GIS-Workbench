// A layer terrain correction can run on (REG-085): a Sentinel-1 SAFE opened with its annotation's
// orbit and its calibration. A pure leaf, shared by the eager stub and the sargeo block, so the block
// does not import the stub (and with it a second copy of the lazy host).
export const s1Layer = (l) => !!l?.info?.meta?.s1?.annotation?.orbit?.t?.length && !!l.info.meta.s1.files?.calibration;
