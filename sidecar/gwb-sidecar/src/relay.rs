//! Loopback relay of the MCP JSON-RPC (REQ-GAP-02, SCN-61, OD-2.20): how a Python script in the
//! user's own environment drives the app. The app is a page and cannot listen, so the sidecar sits
//! between them:
//!
//! - the page turns the relay on (`POST /v1/relay/attach`) and long-polls for messages;
//! - a client paired through the sidecar window POSTs one JSON-RPC message to `/relay/v1/mcp` and
//!   the request stays open until the page's MCP server has answered.
//!
//! The sidecar interprets nothing but the envelope: the page's MCP server decides what a message
//! does, and its rule that a write becomes a Proposal is the only write path. There is no route
//! from a client to the files, jobs or pairing of a page, and nothing here opens a socket.

use gwb_sidecar_api::RelayDelivery;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, watch};

/// The name relay tokens are stored under. It has no `://`, so no Origin header can ever match it
/// (`security::normalise_origin` refuses it), and a relay token opens no `/v1/` route.
pub const RELAY_ORIGIN: &str = "python-relay";
/// Messages waiting or being answered, over all clients.
pub const MAX_OUTSTANDING: usize = 32;
/// Longest one `inbox` request is held.
pub const HOLD: Duration = Duration::from_secs(25);
/// The most a client's call waits for the page.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(300);
/// A page that has not polled for this long has gone (closed, reloaded or frozen).
pub const STALE: Duration = Duration::from_secs(60);

/// Methods a client may send: the MCP server's own list. Anything else stops at the sidecar.
pub const METHODS: [&str; 7] = ["initialize", "ping", "tools/list", "tools/call", "resources/list", "resources/read", "prompts/list"];
/// Notifications the MCP server ignores: acknowledged here, never sent to the page.
pub const NOTIFICATIONS: [&str; 2] = ["notifications/initialized", "notifications/cancelled"];
const MAX_ID_CHARS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayError {
    /// No page has the relay on.
    NoApp,
    /// The page stopped answering or turned the relay off while the call waited.
    AppGone,
    Busy,
    Timeout,
    Stopping,
    BadReply(String),
    /// Another page holds the relay.
    Held,
    NotAttached,
    NoSuchCall,
}

impl RelayError {
    /// HTTP status, error code and the message (English, shown to developers: DN-62 rule 7).
    pub fn http(&self) -> (u16, &'static str, String) {
        match self {
            RelayError::NoApp => (503, "no_app", "no GIS Workbench page has the Python relay on: open Sidecar ▸ Python Relay… in the app".into()),
            RelayError::AppGone => (503, "app_gone", "the page stopped answering or turned the relay off; the call may or may not have reached it".into()),
            RelayError::Busy => (429, "busy", format!("{MAX_OUTSTANDING} calls are already waiting for the page")),
            RelayError::Timeout => (504, "relay_timeout", format!("the page did not answer within {} s", CALL_TIMEOUT.as_secs())),
            RelayError::Stopping => (503, "stopping", "the sidecar is stopping".into()),
            RelayError::BadReply(m) => (502, "bad_reply", format!("the page's reply is not a valid answer: {m}")),
            RelayError::Held => (409, "relay_held", "another page has the relay on; turn it off there first".into()),
            RelayError::NotAttached => (404, "not_attached", "the relay is not on for this page".into()),
            RelayError::NoSuchCall => (404, "no_such_call", "no call is waiting for this reply (it may have timed out)".into()),
        }
    }
}

/// A message that passed `check_message`.
#[derive(Debug, Clone, PartialEq)]
pub struct Checked {
    pub value: Value,
    pub notification: bool,
    /// For the request log: the method and, for a tool call, the tool. Never the arguments.
    pub label: String,
}

/// The envelope check, the relay's only parser: one JSON-RPC 2.0 request object, a method of the
/// MCP server's list, no batch, no extra member. Refusals name what was wrong.
pub fn check_message(v: Value) -> Result<Checked, String> {
    let o = match &v {
        Value::Array(_) => return Err("batches are not accepted: send one message at a time".into()),
        Value::Object(o) => o,
        _ => return Err("the message must be a JSON-RPC object".into()),
    };
    if let Some(k) = o.keys().find(|k| !matches!(k.as_str(), "jsonrpc" | "id" | "method" | "params")) {
        return Err(format!("unknown member {:?}", k.chars().take(40).collect::<String>()));
    }
    if o.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("jsonrpc must be \"2.0\"".into());
    }
    let Some(method) = o.get("method").and_then(Value::as_str) else { return Err("method must be a string".into()) };
    let id = o.get("id");
    let notification = NOTIFICATIONS.contains(&method);
    match id {
        None | Some(Value::Null) => {
            if !notification {
                return Err(format!("{} needs an id", method.chars().take(40).collect::<String>()));
            }
        }
        Some(_) if notification => return Err("a notification has no id".into()),
        Some(Value::String(s)) if s.chars().count() <= MAX_ID_CHARS => {}
        Some(Value::Number(n)) if n.is_i64() || n.is_u64() => {}
        Some(_) => return Err("id must be a string of at most 128 characters or an integer".into()),
    }
    if !notification && !METHODS.contains(&method) {
        return Err(format!("method {:?} is not relayed", method.chars().take(40).collect::<String>()));
    }
    if !matches!(o.get("params"), None | Some(Value::Object(_))) {
        return Err("params must be an object".into());
    }
    let tool = (method == "tools/call").then(|| o.get("params").and_then(|p| p.get("name")).and_then(Value::as_str)).flatten();
    if method == "tools/call" && tool.is_none() {
        return Err("tools/call needs params.name".into());
    }
    let label = match tool {
        Some(t) => format!("tools/call {}", t.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')).take(64).collect::<String>()),
        None => method.to_string(),
    };
    Ok(Checked { notification, label, value: v })
}

/// The reply must answer the message it claims to: same id, a result or an error, not both.
pub fn check_reply(v: &Value, id: &Value) -> Result<(), String> {
    let Some(o) = v.as_object() else { return Err("not an object".into()) };
    if o.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("jsonrpc must be \"2.0\"".into());
    }
    if o.get("id") != Some(id) {
        return Err("its id is not the request's".into());
    }
    if o.contains_key("result") == o.contains_key("error") {
        return Err("it needs exactly one of result and error".into());
    }
    if let Some(k) = o.keys().find(|k| !matches!(k.as_str(), "jsonrpc" | "id" | "result" | "error")) {
        return Err(format!("unknown member {:?}", k.chars().take(40).collect::<String>()));
    }
    Ok(())
}

struct Attached {
    session: String,
    owner: String,
    origin: String,
    client: String,
    since: String,
    last_poll: Instant,
}

struct Waiter {
    tx: oneshot::Sender<Result<Value, RelayError>>,
    id: Value,
}

struct State {
    attached: Option<Attached>,
    queue: VecDeque<RelayDelivery>,
    waiting: HashMap<String, Waiter>,
    calls: u64,
    stale: Duration,
    call_timeout: Duration,
}

impl State {
    /// Drop the attachment; every waiting call ends (their senders drop).
    fn detach(&mut self) {
        self.attached = None;
        self.queue.clear();
        self.waiting.clear();
    }
    fn live(&mut self) -> Option<&Attached> {
        if self.attached.as_ref().is_some_and(|a| a.last_poll.elapsed() >= self.stale) {
            self.detach();
        }
        self.attached.as_ref()
    }
}

pub struct Relay {
    st: Mutex<State>,
    /// Bumped when the queue or the attachment changes; wakes a held `inbox`.
    bump: watch::Sender<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RelayStatus {
    pub on: bool,
    pub origin: Option<String>,
    pub client: Option<String>,
    pub since: Option<String>,
    pub calls: u64,
    pub outstanding: usize,
}

impl Default for Relay {
    fn default() -> Self {
        Relay::new()
    }
}

impl Relay {
    pub fn new() -> Relay {
        let (bump, _) = watch::channel(0);
        Relay { st: Mutex::new(State { attached: None, queue: VecDeque::new(), waiting: HashMap::new(), calls: 0, stale: STALE, call_timeout: CALL_TIMEOUT }), bump }
    }

    /// Shorter limits for tests.
    pub fn set_limits(&self, stale: Duration, call_timeout: Duration) {
        let mut s = self.st.lock().unwrap();
        s.stale = stale;
        s.call_timeout = call_timeout;
    }

    fn wake(&self) {
        self.bump.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Turn the relay on for a page. A live attachment of another page keeps it; the same owner
    /// (a reloaded page) takes over its own.
    pub fn attach(&self, owner: &str, origin: &str, client: &str) -> Result<String, RelayError> {
        let session = crate::util::random_hex(24);
        {
            let mut s = self.st.lock().unwrap();
            if s.live().is_some_and(|a| a.owner != owner) {
                return Err(RelayError::Held);
            }
            s.detach();
            let client: String = client.chars().filter(|c| !c.is_control()).take(80).collect();
            s.attached = Some(Attached { session: session.clone(), owner: owner.into(), origin: origin.into(), client, since: crate::util::now_rfc3339(), last_poll: Instant::now() });
        }
        self.wake();
        Ok(session)
    }

    pub fn detach(&self, session: &str, owner: &str) -> Result<(), RelayError> {
        {
            let mut s = self.st.lock().unwrap();
            if !s.attached.as_ref().is_some_and(|a| a.session == session && a.owner == owner) {
                return Err(RelayError::NotAttached);
            }
            s.detach();
        }
        self.wake();
        Ok(())
    }

    /// The page's pairing went: the relay goes with it.
    pub fn detach_where(&self, gone: impl Fn(&str, &str) -> bool) {
        let mut s = self.st.lock().unwrap();
        if s.attached.as_ref().is_some_and(|a| gone(&a.origin, &a.owner)) {
            s.detach();
            drop(s);
            self.wake();
        }
    }

    pub fn app_on(&self) -> bool {
        self.st.lock().unwrap().live().is_some()
    }

    pub fn status(&self) -> RelayStatus {
        let mut s = self.st.lock().unwrap();
        let a = s.live().map(|a| (a.origin.clone(), a.client.clone(), a.since.clone()));
        RelayStatus { on: a.is_some(), origin: a.as_ref().map(|x| x.0.clone()), client: a.as_ref().map(|x| x.1.clone()), since: a.map(|x| x.2), calls: s.calls, outstanding: s.waiting.len() }
    }

    /// Queue a checked request for the page. Dropping the ticket (the client went away) takes the
    /// message back if the page has not had it yet.
    pub fn submit(&self, client: &str, value: Value) -> Result<Ticket<'_>, RelayError> {
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let rid = crate::util::random_hex(12);
        let (tx, rx) = oneshot::channel();
        let (session, timeout) = {
            let mut s = self.st.lock().unwrap();
            let session = s.live().map(|a| a.session.clone()).ok_or(RelayError::NoApp)?;
            if s.waiting.len() >= MAX_OUTSTANDING {
                return Err(RelayError::Busy);
            }
            s.calls += 1;
            s.waiting.insert(rid.clone(), Waiter { tx, id });
            s.queue.push_back(RelayDelivery { rid: rid.clone(), client: client.into(), message: value });
            (session, s.call_timeout)
        };
        self.wake();
        Ok(Ticket { relay: self, rid, rx, session, deadline: Instant::now() + timeout })
    }

    fn poll_mark(&self, session: &str, owner: &str) -> Result<Option<RelayDelivery>, RelayError> {
        let mut s = self.st.lock().unwrap();
        match s.live() {
            Some(a) if a.session == session && a.owner == owner => {}
            _ => return Err(RelayError::NotAttached),
        }
        if let Some(a) = s.attached.as_mut() {
            a.last_poll = Instant::now();
        }
        Ok(s.queue.pop_front())
    }

    /// The next message for the page, or None after `hold`: the page polls again.
    pub async fn next(&self, session: &str, owner: &str, hold: Duration) -> Result<Option<RelayDelivery>, RelayError> {
        let until = tokio::time::Instant::now() + hold;
        let mut rx = self.bump.subscribe();
        loop {
            rx.borrow_and_update();
            if let Some(m) = self.poll_mark(session, owner)? {
                return Ok(Some(m));
            }
            tokio::select! {
                r = rx.changed() => { if r.is_err() { return Ok(None); } }
                _ = tokio::time::sleep_until(until) => return Ok(None),
                _ = crate::QUIT.notified() => return Ok(None),
            }
        }
    }

    /// The page's answer to delivery `rid`. A reply that does not answer its request fails that
    /// call as well as this request.
    pub fn reply(&self, session: &str, owner: &str, rid: &str, reply: Value) -> Result<(), RelayError> {
        let w = {
            let mut s = self.st.lock().unwrap();
            if !s.attached.as_ref().is_some_and(|a| a.session == session && a.owner == owner) {
                return Err(RelayError::NotAttached);
            }
            s.waiting.remove(rid).ok_or(RelayError::NoSuchCall)?
        };
        match check_reply(&reply, &w.id) {
            Ok(()) => {
                let _ = w.tx.send(Ok(reply));
                Ok(())
            }
            Err(m) => {
                let e = RelayError::BadReply(m);
                let _ = w.tx.send(Err(e.clone()));
                Err(e)
            }
        }
    }

    fn forget(&self, rid: &str) {
        let mut s = self.st.lock().unwrap();
        s.waiting.remove(rid);
        s.queue.retain(|d| d.rid != rid);
    }

    fn session_live(&self, session: &str) -> bool {
        self.st.lock().unwrap().live().is_some_and(|a| a.session == session)
    }
}

/// One call waiting for the page. Dropping it withdraws the call.
pub struct Ticket<'a> {
    relay: &'a Relay,
    rid: String,
    rx: oneshot::Receiver<Result<Value, RelayError>>,
    session: String,
    deadline: Instant,
}

impl Ticket<'_> {
    pub async fn wait(&mut self) -> Result<Value, RelayError> {
        loop {
            tokio::select! {
                r = &mut self.rx => return r.unwrap_or(Err(RelayError::AppGone)),
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    if !self.relay.session_live(&self.session) {
                        return Err(RelayError::AppGone);
                    }
                    if Instant::now() >= self.deadline {
                        return Err(RelayError::Timeout);
                    }
                }
                _ = crate::QUIT.notified() => return Err(RelayError::Stopping),
            }
        }
    }
}

impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        self.relay.forget(&self.rid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(m: &str) -> Value {
        json!({"jsonrpc": "2.0", "id": 1, "method": m, "params": {"name": "gw_x"}})
    }

    #[test]
    fn the_envelope_is_checked() {
        for m in METHODS {
            assert!(check_message(msg(m)).is_ok(), "{m}");
        }
        assert_eq!(check_message(msg("tools/call")).unwrap().label, "tools/call gw_x");
        assert_eq!(check_message(msg("ping")).unwrap().label, "ping");
        for n in NOTIFICATIONS {
            assert!(check_message(json!({"jsonrpc": "2.0", "method": n})).unwrap().notification);
        }
        let bad = [
            json!([msg("ping")]),
            json!("ping"),
            json!(1),
            json!(null),
            json!({"id": 1, "method": "ping"}),
            json!({"jsonrpc": "1.0", "id": 1, "method": "ping"}),
            json!({"jsonrpc": "2.0", "id": 1}),
            json!({"jsonrpc": "2.0", "id": 1, "method": 7}),
            json!({"jsonrpc": "2.0", "method": "ping"}),
            json!({"jsonrpc": "2.0", "id": null, "method": "tools/call", "params": {"name": "x"}}),
            json!({"jsonrpc": "2.0", "id": 1.5, "method": "ping"}),
            json!({"jsonrpc": "2.0", "id": [1], "method": "ping"}),
            json!({"jsonrpc": "2.0", "id": "x".repeat(129), "method": "ping"}),
            json!({"jsonrpc": "2.0", "id": 1, "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 1, "method": "sampling/createMessage"}),
            json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": [1]}),
            json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "extra": 1}),
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call"}),
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": 3}}),
        ];
        for b in bad {
            assert!(check_message(b.clone()).is_err(), "{b}");
        }
    }

    #[test]
    fn the_log_label_is_clean() {
        let c = check_message(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "a\r\nb c", "arguments": {"secret": "s"}}})).unwrap();
        assert_eq!(c.label, "tools/call abc");
    }

    #[test]
    fn replies_must_answer_their_request() {
        let id = json!(7);
        assert!(check_reply(&json!({"jsonrpc": "2.0", "id": 7, "result": {}}), &id).is_ok());
        assert!(check_reply(&json!({"jsonrpc": "2.0", "id": 7, "error": {"code": -1, "message": "x"}}), &id).is_ok());
        for b in [json!({"jsonrpc": "2.0", "id": 8, "result": {}}), json!({"jsonrpc": "2.0", "id": 7}), json!({"jsonrpc": "2.0", "id": 7, "result": {}, "error": {}}), json!({"id": 7, "result": {}}), json!({"jsonrpc": "2.0", "id": 7, "result": {}, "x": 1}), json!([])] {
            assert!(check_reply(&b, &id).is_err(), "{b}");
        }
    }

    #[test]
    fn one_page_at_a_time() {
        let r = Relay::new();
        assert_eq!(r.submit("c", msg("ping")).err(), Some(RelayError::NoApp));
        let a = r.attach("o1", "null", "page").unwrap();
        assert!(r.app_on());
        assert_eq!(r.attach("o2", "null", "page"), Err(RelayError::Held));
        let b = r.attach("o1", "null", "page").unwrap(); // reloaded: takes over its own
        assert_ne!(a, b);
        assert_eq!(r.detach(&a, "o1"), Err(RelayError::NotAttached));
        assert_eq!(r.detach(&b, "o2"), Err(RelayError::NotAttached));
        r.detach(&b, "o1").unwrap();
        assert!(!r.app_on());
        r.attach("o2", "null", "page").unwrap();
        r.detach_where(|_, o| o == "o2");
        assert!(!r.app_on());
    }

    #[test]
    fn a_stale_page_loses_the_relay() {
        let r = Relay::new();
        r.set_limits(Duration::ZERO, CALL_TIMEOUT);
        r.attach("o1", "null", "page").unwrap();
        assert!(!r.app_on());
        r.attach("o1", "null", "page").unwrap();
        assert!(r.attach("o2", "null", "page").is_ok());
    }

    #[tokio::test]
    async fn a_call_goes_to_the_page_and_back() {
        let r = Relay::new();
        let s = r.attach("o", "null", "page").unwrap();
        let mut t = r.submit("my script", msg("ping")).unwrap();
        let d = r.next(&s, "o", HOLD).await.unwrap().unwrap();
        assert_eq!(d.client, "my script");
        assert_eq!(d.message, msg("ping"));
        assert_eq!(r.next(&s, "bad", Duration::ZERO).await, Err(RelayError::NotAttached));
        assert_eq!(r.next("bad", "o", Duration::ZERO).await, Err(RelayError::NotAttached));
        assert_eq!(r.reply(&s, "other", &d.rid, json!({})), Err(RelayError::NotAttached));
        r.reply(&s, "o", &d.rid, json!({"jsonrpc": "2.0", "id": 1, "result": {}})).unwrap();
        assert_eq!(t.wait().await.unwrap()["result"], json!({}));
        assert_eq!(r.reply(&s, "o", &d.rid, json!({})), Err(RelayError::NoSuchCall));
    }

    #[tokio::test]
    async fn a_withdrawn_call_never_reaches_the_page() {
        let r = Relay::new();
        let s = r.attach("o", "null", "page").unwrap();
        drop(r.submit("c", msg("tools/call")).unwrap());
        assert_eq!(r.next(&s, "o", Duration::ZERO).await.unwrap(), None);
        assert_eq!(r.status().outstanding, 0);
    }

    #[tokio::test]
    async fn the_queue_is_bounded_and_detach_ends_calls() {
        let r = Relay::new();
        let s = r.attach("o", "null", "page").unwrap();
        let mut held: Vec<_> = (0..MAX_OUTSTANDING).map(|_| r.submit("c", msg("ping")).unwrap()).collect();
        assert_eq!(r.submit("c", msg("ping")).err(), Some(RelayError::Busy));
        r.detach(&s, "o").unwrap();
        assert_eq!(held[0].wait().await, Err(RelayError::AppGone));
        held.clear();
        assert_eq!(r.status().outstanding, 0);
    }

    #[tokio::test]
    async fn a_bad_reply_fails_the_call() {
        let r = Relay::new();
        let s = r.attach("o", "null", "page").unwrap();
        let mut t = r.submit("c", msg("ping")).unwrap();
        let d = r.next(&s, "o", HOLD).await.unwrap().unwrap();
        assert!(matches!(r.reply(&s, "o", &d.rid, json!({"jsonrpc": "2.0", "id": 2, "result": {}})), Err(RelayError::BadReply(_))));
        assert!(matches!(t.wait().await, Err(RelayError::BadReply(_))));
    }

    #[tokio::test]
    async fn a_call_times_out() {
        let r = Relay::new();
        r.set_limits(STALE, Duration::from_millis(10));
        r.attach("o", "null", "page").unwrap();
        let mut t = r.submit("c", msg("ping")).unwrap();
        assert_eq!(t.wait().await, Err(RelayError::Timeout));
    }

    #[tokio::test]
    async fn a_held_poll_wakes_for_a_message() {
        let r = std::sync::Arc::new(Relay::new());
        let s = r.attach("o", "null", "page").unwrap();
        let (r2, s2) = (r.clone(), s.clone());
        let p = tokio::spawn(async move { r2.next(&s2, "o", Duration::from_secs(20)).await });
        tokio::task::yield_now().await;
        let _t = r.submit("c", msg("ping")).unwrap();
        let got = tokio::time::timeout(Duration::from_secs(5), p).await.unwrap().unwrap().unwrap();
        assert!(got.is_some());
    }
}
