//! View and cursor sync with ArcGIS Pro (REQ-GAP-65, SDP-2.3 GR-23). Two programs on this computer
//! cannot reach each other: the app is a page and Pro's add-in has no way into it. The sidecar holds
//! one small piece of state between them:
//!
//! - the page turns sync on (`POST /v1/sync/attach`), says who follows whom, publishes its view and
//!   cursor, and long-polls for the add-in's;
//! - an add-in paired through the sidecar window does the same on `/sync/v1/`.
//!
//! Only a position passes: longitude, latitude, ground scale, rotation and a cursor. It is state,
//! not a queue, so a side that falls behind reads the present and nothing can pile up. There is no
//! route from the add-in to the page's files, jobs, pairing or MCP tools, and nothing here opens a
//! socket. Numbers are checked before they are stored; both sides read only checked state.

use gwb_sidecar_api::{SyncCursor, SyncDirection, SyncPublish, SyncUpdate, SyncView};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// The name add-in tokens are stored under. It has no `://`, so no Origin header can ever match it,
/// and an add-in token opens no `/v1/` route and no `/relay/` route.
pub const SYNC_ORIGIN: &str = "arcgis-pro-addin";
/// Longest one `next` request is held.
pub const HOLD: Duration = Duration::from_secs(25);
/// A side that has not polled for this long has gone.
pub const STALE: Duration = Duration::from_secs(60);
/// Publishes one side may make per second. A cursor is sent at most at display rate; this catches a
/// runaway loop between the two sides, which is the failure this design has to fear.
pub const MAX_RATE: u32 = 200;
/// Largest ground scale taken: more than the Earth on one pixel.
pub const MAX_MPP: f64 = 1e8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    App,
    Pro,
}

impl Side {
    fn other(self) -> Side {
        match self {
            Side::App => Side::Pro,
            Side::Pro => Side::App,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    /// No page has sync on.
    NoApp,
    /// Another page holds sync.
    Held,
    NotAttached,
    /// This side follows the other, so it may not publish.
    Follows,
    Busy,
    Bad(String),
}

impl SyncError {
    /// HTTP status, error code and the message (English, shown to developers: DN-62 rule 7).
    pub fn http(&self) -> (u16, &'static str, String) {
        match self {
            SyncError::NoApp => (503, "no_app", "no GIS Workbench page has sync on: open Sidecar ▸ Sync with ArcGIS Pro… in the app".into()),
            SyncError::Held => (409, "sync_held", "another page has sync on; turn it off there first".into()),
            SyncError::NotAttached => (404, "not_attached", "sync is not on for this page".into()),
            SyncError::Follows => (409, "follows", "this side follows the other, so it cannot publish: change the direction in the app".into()),
            SyncError::Busy => (429, "busy", format!("more than {MAX_RATE} updates in a second: is one side answering the other?")),
            SyncError::Bad(m) => (400, "bad_state", m.clone()),
        }
    }
}

fn in_range(name: &str, v: f64, lo: f64, hi: f64) -> Result<(), String> {
    if v.is_finite() && v >= lo && v <= hi {
        Ok(())
    } else {
        Err(format!("{name} must be between {lo} and {hi}"))
    }
}

/// The only check between one program's numbers and the other's map.
pub fn check_view(v: &SyncView) -> Result<(), String> {
    in_range("lon", v.lon, -180.0, 180.0)?;
    in_range("lat", v.lat, -90.0, 90.0)?;
    in_range("rotation", v.rotation, -360.0, 360.0)?;
    if !(v.mpp.is_finite() && v.mpp > 0.0 && v.mpp <= MAX_MPP) {
        return Err(format!("mpp must be above 0 and at most {MAX_MPP}"));
    }
    Ok(())
}

pub fn check_cursor(c: &SyncCursor) -> Result<(), String> {
    in_range("lon", c.lon, -180.0, 180.0)?;
    in_range("lat", c.lat, -90.0, 90.0)
}

pub fn check_publish(p: &SyncPublish) -> Result<(), String> {
    if p.view.is_none() && p.cursor.is_none() {
        return Err("a publish needs a view or a cursor".into());
    }
    if let Some(v) = &p.view {
        check_view(v)?;
    }
    if let Some(c) = &p.cursor {
        check_cursor(c)?;
    }
    Ok(())
}

#[derive(Default)]
struct Published {
    view: Option<(u64, SyncView)>,
    cursor: Option<(u64, SyncCursor)>,
    window: Option<Instant>,
    in_window: u32,
    total: u64,
}

impl Published {
    fn clear(&mut self) {
        *self = Published { total: self.total, ..Published::default() };
    }
}

struct Attached {
    session: String,
    owner: String,
    origin: String,
    client: String,
    since: String,
    direction: SyncDirection,
    last_poll: Instant,
}

struct State {
    attached: Option<Attached>,
    addin: Option<(String, Instant)>,
    app: Published,
    pro: Published,
    /// Every accepted publish takes the next number: readers compare against their `after`.
    seq: u64,
    stale: Duration,
}

impl State {
    fn detach(&mut self) {
        self.attached = None;
        self.app.clear();
        self.pro.clear();
    }
    fn live(&mut self) -> Option<&Attached> {
        if self.attached.as_ref().is_some_and(|a| a.last_poll.elapsed() >= self.stale) {
            self.detach();
        }
        self.attached.as_ref()
    }
    fn side(&mut self, s: Side) -> &mut Published {
        match s {
            Side::App => &mut self.app,
            Side::Pro => &mut self.pro,
        }
    }
    fn addin_live(&self) -> bool {
        self.addin.as_ref().is_some_and(|(_, t)| t.elapsed() < self.stale)
    }
}

pub struct Sync {
    st: Mutex<State>,
    bump: watch::Sender<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncStatus {
    pub on: bool,
    pub origin: Option<String>,
    pub client: Option<String>,
    pub since: Option<String>,
    pub direction: Option<SyncDirection>,
    /// The add-in's name, while it is polling.
    pub addin: Option<String>,
    pub from_app: u64,
    pub from_pro: u64,
}

impl Default for Sync {
    fn default() -> Self {
        Sync::new()
    }
}

impl Sync {
    pub fn new() -> Sync {
        let (bump, _) = watch::channel(0);
        Sync { st: Mutex::new(State { attached: None, addin: None, app: Published::default(), pro: Published::default(), seq: 0, stale: STALE }), bump }
    }

    /// A shorter limit for tests.
    pub fn set_stale(&self, stale: Duration) {
        self.st.lock().unwrap().stale = stale;
    }

    fn wake(&self) {
        self.bump.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Turn sync on for a page. A live attachment of another page keeps it; the same owner (a
    /// reloaded page) takes over its own. What either side published before goes.
    pub fn attach(&self, owner: &str, origin: &str, client: &str, direction: SyncDirection) -> Result<String, SyncError> {
        let session = crate::util::random_hex(24);
        {
            let mut s = self.st.lock().unwrap();
            if s.live().is_some_and(|a| a.owner != owner) {
                return Err(SyncError::Held);
            }
            s.detach();
            let client: String = client.chars().filter(|c| !c.is_control()).take(80).collect();
            s.attached = Some(Attached { session: session.clone(), owner: owner.into(), origin: origin.into(), client, since: crate::util::now_rfc3339(), direction, last_poll: Instant::now() });
        }
        self.wake();
        Ok(session)
    }

    pub fn detach(&self, session: &str, owner: &str) -> Result<(), SyncError> {
        {
            let mut s = self.st.lock().unwrap();
            if !s.attached.as_ref().is_some_and(|a| a.session == session && a.owner == owner) {
                return Err(SyncError::NotAttached);
            }
            s.detach();
        }
        self.wake();
        Ok(())
    }

    /// The page's pairing went: sync goes with it.
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

    pub fn direction(&self) -> Option<SyncDirection> {
        self.st.lock().unwrap().live().map(|a| a.direction)
    }

    pub fn status(&self) -> SyncStatus {
        let mut s = self.st.lock().unwrap();
        let a = s.live().map(|a| (a.origin.clone(), a.client.clone(), a.since.clone(), a.direction));
        let addin = s.addin.as_ref().filter(|_| s.addin_live()).map(|x| x.0.clone());
        let (from_app, from_pro) = (s.app.total, s.pro.total);
        match a {
            Some((o, c, t, d)) => SyncStatus { on: true, origin: Some(o), client: Some(c), since: Some(t), direction: Some(d), addin, from_app, from_pro },
            None => SyncStatus { on: false, origin: None, client: None, since: None, direction: None, addin, from_app, from_pro },
        }
    }

    fn publish_inner(s: &mut State, side: Side, p: &SyncPublish) -> Result<u64, SyncError> {
        let Some(a) = s.live() else { return Err(SyncError::NoApp) };
        let follows = matches!((side, a.direction), (Side::App, SyncDirection::AppFollows) | (Side::Pro, SyncDirection::ProFollows));
        if follows {
            return Err(SyncError::Follows);
        }
        check_publish(p).map_err(SyncError::Bad)?;
        let seq = s.seq + 1;
        let out = s.side(side);
        let now = Instant::now();
        match out.window {
            Some(t) if now.duration_since(t) < Duration::from_secs(1) => {
                if out.in_window >= MAX_RATE {
                    return Err(SyncError::Busy);
                }
                out.in_window += 1;
            }
            _ => {
                out.window = Some(now);
                out.in_window = 1;
            }
        }
        if let Some(v) = p.view {
            out.view = Some((seq, v));
        }
        if let Some(c) = p.cursor {
            out.cursor = Some((seq, c));
        }
        out.total += 1;
        s.seq = seq;
        Ok(seq)
    }

    /// The add-in publishes. Its token was checked; it needs no session.
    pub fn publish_pro(&self, client: &str, p: &SyncPublish) -> Result<u64, SyncError> {
        let seq = {
            let mut s = self.st.lock().unwrap();
            s.addin = Some((client.to_string(), Instant::now()));
            Sync::publish_inner(&mut s, Side::Pro, p)?
        };
        self.wake();
        Ok(seq)
    }

    pub fn publish_app(&self, session: &str, owner: &str, p: &SyncPublish) -> Result<u64, SyncError> {
        let seq = {
            let mut s = self.st.lock().unwrap();
            match s.live() {
                Some(a) if a.session == session && a.owner == owner => {}
                _ => return Err(SyncError::NotAttached),
            }
            Sync::publish_inner(&mut s, Side::App, p)?
        };
        self.wake();
        Ok(seq)
    }

    fn poll(&self, side: Side, session: Option<(&str, &str)>, client: Option<&str>, after: u64) -> Result<Option<SyncUpdate>, SyncError> {
        let mut s = self.st.lock().unwrap();
        if let Some((sess, owner)) = session {
            match s.live() {
                Some(a) if a.session == sess && a.owner == owner => {}
                _ => return Err(SyncError::NotAttached),
            }
            if let Some(a) = s.attached.as_mut() {
                a.last_poll = Instant::now();
            }
        }
        if let Some(c) = client {
            s.addin = Some((c.to_string(), Instant::now()));
        }
        let peer = match side {
            Side::App => s.addin_live(),
            Side::Pro => s.live().is_some(),
        };
        // A number from before this attachment (the page reloaded, sync went off and on): start again.
        let after = if after > s.seq { 0 } else { after };
        let them = s.side(side.other());
        let view = them.view.filter(|(n, _)| *n > after).map(|x| x.1);
        let cursor = them.cursor.filter(|(n, _)| *n > after).map(|x| x.1);
        let seq = s.seq;
        if view.is_some() || cursor.is_some() {
            Ok(Some(SyncUpdate { seq, peer, view, cursor }))
        } else {
            Ok(None)
        }
    }

    async fn next_inner(&self, side: Side, session: Option<(&str, &str)>, client: Option<&str>, after: u64, hold: Duration) -> Result<SyncUpdate, SyncError> {
        let until = tokio::time::Instant::now() + hold;
        let mut rx = self.bump.subscribe();
        loop {
            rx.borrow_and_update();
            if let Some(u) = self.poll(side, session, client, after)? {
                return Ok(u);
            }
            tokio::select! {
                r = rx.changed() => { if r.is_err() { break; } }
                _ = tokio::time::sleep_until(until) => break,
                _ = crate::QUIT.notified() => break,
            }
        }
        let s = self.st.lock().unwrap();
        let peer = match side {
            Side::App => s.addin_live(),
            Side::Pro => s.attached.is_some(),
        };
        Ok(SyncUpdate { seq: s.seq, peer, view: None, cursor: None })
    }

    /// What the add-in has not seen, or an empty update after `hold` (it simply asks again).
    pub async fn next_pro(&self, client: &str, after: u64, hold: Duration) -> Result<SyncUpdate, SyncError> {
        self.next_inner(Side::Pro, None, Some(client), after, hold).await
    }

    pub async fn next_app(&self, session: &str, owner: &str, after: u64, hold: Duration) -> Result<SyncUpdate, SyncError> {
        self.next_inner(Side::App, Some((session, owner)), None, after, hold).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const V: SyncView = SyncView { lon: -105.0, lat: 39.7, mpp: 2.5, rotation: 0.0 };
    const C: SyncCursor = SyncCursor { lon: -105.1, lat: 39.6, visible: true };
    fn pv(v: SyncView) -> SyncPublish {
        SyncPublish { view: Some(v), cursor: None }
    }
    fn pc(c: SyncCursor) -> SyncPublish {
        SyncPublish { view: None, cursor: Some(c) }
    }

    #[test]
    fn numbers_are_checked() {
        assert!(check_publish(&pv(V)).is_ok());
        assert!(check_publish(&pc(C)).is_ok());
        assert!(check_publish(&SyncPublish { view: None, cursor: None }).is_err());
        for v in [
            SyncView { lon: 180.5, ..V },
            SyncView { lon: f64::NAN, ..V },
            SyncView { lat: -91.0, ..V },
            SyncView { lat: f64::INFINITY, ..V },
            SyncView { mpp: 0.0, ..V },
            SyncView { mpp: -1.0, ..V },
            SyncView { mpp: f64::NAN, ..V },
            SyncView { mpp: 1e9, ..V },
            SyncView { rotation: 361.0, ..V },
            SyncView { rotation: f64::NEG_INFINITY, ..V },
        ] {
            assert!(check_publish(&pv(v)).is_err(), "{v:?}");
        }
        for c in [SyncCursor { lon: 200.0, ..C }, SyncCursor { lat: 100.0, ..C }, SyncCursor { lon: f64::NAN, ..C }] {
            assert!(check_publish(&pc(c)).is_err(), "{c:?}");
        }
    }

    #[test]
    fn nothing_passes_until_a_page_turns_it_on() {
        let y = Sync::new();
        assert_eq!(y.publish_pro("pro", &pv(V)), Err(SyncError::NoApp));
        assert_eq!(y.publish_app("s", "o", &pv(V)), Err(SyncError::NotAttached));
        let s = y.attach("o", "null", "page", SyncDirection::Both).unwrap();
        y.publish_pro("pro", &pv(V)).unwrap();
        y.detach(&s, "o").unwrap();
        assert_eq!(y.publish_pro("pro", &pv(V)), Err(SyncError::NoApp));
    }

    #[test]
    fn one_page_at_a_time_and_it_can_take_over_its_own() {
        let y = Sync::new();
        let a = y.attach("o1", "null", "p", SyncDirection::Both).unwrap();
        assert_eq!(y.attach("o2", "null", "p", SyncDirection::Both), Err(SyncError::Held));
        let b = y.attach("o1", "null", "p", SyncDirection::Both).unwrap();
        assert_ne!(a, b);
        assert_eq!(y.detach(&a, "o1"), Err(SyncError::NotAttached));
        assert_eq!(y.detach(&b, "o2"), Err(SyncError::NotAttached));
        y.detach_where(|_, o| o == "o1");
        assert!(!y.app_on());
    }

    #[test]
    fn a_stale_page_loses_sync() {
        let y = Sync::new();
        y.set_stale(Duration::ZERO);
        y.attach("o1", "null", "p", SyncDirection::Both).unwrap();
        assert!(!y.app_on());
        assert!(y.attach("o2", "null", "p", SyncDirection::Both).is_ok());
    }

    #[test]
    fn the_side_that_follows_cannot_publish() {
        let y = Sync::new();
        let s = y.attach("o", "null", "p", SyncDirection::AppFollows).unwrap();
        assert_eq!(y.publish_app(&s, "o", &pv(V)), Err(SyncError::Follows));
        y.publish_pro("pro", &pv(V)).unwrap();
        let s = y.attach("o", "null", "p", SyncDirection::ProFollows).unwrap();
        assert_eq!(y.publish_pro("pro", &pv(V)), Err(SyncError::Follows));
        y.publish_app(&s, "o", &pv(V)).unwrap();
    }

    #[tokio::test]
    async fn each_side_reads_only_the_other() {
        let y = Sync::new();
        let s = y.attach("o", "null", "p", SyncDirection::Both).unwrap();
        y.publish_app(&s, "o", &pv(V)).unwrap();
        // The page does not get its own view back: that would be the loop.
        let u = y.next_app(&s, "o", 0, Duration::ZERO).await.unwrap();
        assert_eq!(u.view, None);
        let u = y.next_pro("pro", 0, Duration::ZERO).await.unwrap();
        assert_eq!(u.view, Some(V));
        assert!(u.peer);
        let w = SyncView { lon: 10.0, ..V };
        y.publish_pro("pro", &pv(w)).unwrap();
        y.publish_pro("pro", &pc(C)).unwrap();
        let u = y.next_app(&s, "o", 0, Duration::ZERO).await.unwrap();
        assert_eq!((u.view, u.cursor), (Some(w), Some(C)));
        assert!(u.peer, "the add-in is there");
    }

    #[tokio::test]
    async fn a_slow_reader_gets_the_present_not_a_backlog() {
        let y = Sync::new();
        let s = y.attach("o", "null", "p", SyncDirection::Both).unwrap();
        let mut last = V;
        for i in 0..100 {
            last = SyncView { lon: i as f64, ..V };
            y.publish_pro("pro", &pv(last)).unwrap();
        }
        let u = y.next_app(&s, "o", 0, Duration::ZERO).await.unwrap();
        assert_eq!(u.view, Some(last));
        assert_eq!(u.seq, 100);
        let u2 = y.next_app(&s, "o", u.seq, Duration::ZERO).await.unwrap();
        assert_eq!(u2.view, None, "nothing new");
    }

    #[tokio::test]
    async fn after_only_reports_what_changed() {
        let y = Sync::new();
        let s = y.attach("o", "null", "p", SyncDirection::Both).unwrap();
        y.publish_pro("pro", &pv(V)).unwrap();
        let u = y.next_app(&s, "o", 0, Duration::ZERO).await.unwrap();
        y.publish_pro("pro", &pc(C)).unwrap();
        let u2 = y.next_app(&s, "o", u.seq, Duration::ZERO).await.unwrap();
        assert_eq!((u2.view, u2.cursor), (None, Some(C)));
    }

    #[tokio::test]
    async fn a_number_from_an_earlier_attachment_starts_again() {
        let y = Sync::new();
        let s = y.attach("o", "null", "p", SyncDirection::Both).unwrap();
        y.publish_pro("pro", &pv(V)).unwrap();
        let u = y.next_app(&s, "o", u64::MAX, Duration::ZERO).await.unwrap();
        assert_eq!(u.view, Some(V));
    }

    #[tokio::test]
    async fn turning_sync_off_forgets_the_positions() {
        let y = Sync::new();
        let s = y.attach("o", "null", "p", SyncDirection::Both).unwrap();
        y.publish_pro("pro", &pv(V)).unwrap();
        y.detach(&s, "o").unwrap();
        let s = y.attach("o", "null", "p", SyncDirection::Both).unwrap();
        assert_eq!(y.next_app(&s, "o", 0, Duration::ZERO).await.unwrap().view, None);
    }

    #[test]
    fn a_runaway_loop_is_refused() {
        let y = Sync::new();
        y.attach("o", "null", "p", SyncDirection::Both).unwrap();
        let mut refused = 0;
        for _ in 0..(MAX_RATE + 50) {
            if y.publish_pro("pro", &pv(V)) == Err(SyncError::Busy) {
                refused += 1;
            }
        }
        assert!(refused >= 1, "over the rate");
    }

    #[tokio::test]
    async fn a_held_poll_wakes_for_a_message() {
        let y = std::sync::Arc::new(Sync::new());
        let s = y.attach("o", "null", "p", SyncDirection::Both).unwrap();
        let (y2, s2) = (y.clone(), s.clone());
        let p = tokio::spawn(async move { y2.next_app(&s2, "o", 0, Duration::from_secs(20)).await });
        tokio::task::yield_now().await;
        y.publish_pro("pro", &pv(V)).unwrap();
        let got = tokio::time::timeout(Duration::from_secs(5), p).await.unwrap().unwrap().unwrap();
        assert_eq!(got.view, Some(V));
    }

    #[tokio::test]
    async fn a_poll_on_a_session_that_went_is_refused() {
        let y = Sync::new();
        let s = y.attach("o", "null", "p", SyncDirection::Both).unwrap();
        assert_eq!(y.next_app(&s, "other", 0, Duration::ZERO).await, Err(SyncError::NotAttached));
        assert_eq!(y.next_app("nope", "o", 0, Duration::ZERO).await, Err(SyncError::NotAttached));
    }
}
