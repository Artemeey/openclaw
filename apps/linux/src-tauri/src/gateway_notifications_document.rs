use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview};
use tokio::sync::oneshot;

#[derive(Default)]
pub(crate) struct BridgeViews(Mutex<Option<Arc<BridgeView>>>);

pub(crate) struct BridgeView {
    active: AtomicBool,
    navigation: AtomicU64,
}

#[derive(Clone)]
pub(crate) struct BridgeDocument {
    view: Arc<BridgeView>,
    navigation: u64,
    pub(crate) id: String,
}

impl BridgeViews {
    pub(crate) fn replace(&self) -> Arc<BridgeView> {
        let view = Arc::new(BridgeView {
            active: AtomicBool::new(true),
            navigation: AtomicU64::new(0),
        });
        if let Some(previous) = self
            .0
            .lock()
            .expect("notification view mutex poisoned")
            .replace(view.clone())
        {
            previous.active.store(false, Ordering::SeqCst);
        }
        view
    }

    pub(crate) fn retire(&self) {
        if let Some(view) = self
            .0
            .lock()
            .expect("notification view mutex poisoned")
            .take()
        {
            view.active.store(false, Ordering::SeqCst);
        }
    }
}

impl BridgeView {
    // Wry navigation decisions also include child frames. Conservatively revoke on
    // every non-bridge navigation; page-load Started arrives only at document commit.
    pub(crate) fn navigated(&self) {
        self.navigation.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn document(self: &Arc<Self>, id: String) -> BridgeDocument {
        BridgeDocument {
            view: self.clone(),
            navigation: self.navigation.load(Ordering::SeqCst),
            id,
        }
    }
}

impl BridgeDocument {
    pub(crate) fn is_attached(&self) -> bool {
        self.view.active.load(Ordering::SeqCst)
    }

    pub(crate) fn is_current(&self) -> bool {
        self.is_attached() && self.view.navigation.load(Ordering::SeqCst) == self.navigation
    }

    pub(crate) async fn admit(&self, webview: &Webview, request_id: &str, payload: &str) -> bool {
        if !self.is_current() {
            return false;
        }
        let args = serde_json::json!([self.id, request_id, payload]);
        let script =
            format!("window.__OPENCLAW_NATIVE_NOTIFICATIONS_ADMIT__?.(...{args}) === true");
        let (sender, receiver) = oneshot::channel();
        let sender = Mutex::new(Some(sender));
        if webview
            .eval_with_callback(script, move |result| {
                if let Some(sender) = sender
                    .lock()
                    .expect("notification admission mutex poisoned")
                    .take()
                {
                    let _ = sender.send(result == "true");
                }
            })
            .is_err()
        {
            return false;
        }
        // Wry may drop callbacks while initial scripts are queued. Dispatch success
        // is not document proof, and a callback from a replaced page grants nothing.
        if !matches!(
            tokio::time::timeout(Duration::from_secs(5), receiver).await,
            Ok(Ok(true))
        ) || !self.is_current()
        {
            return false;
        }
        // Clear only this admitted request's transport timeout. The permission prompt
        // may legitimately outlive it; a dropped eval callback never reaches this ack.
        let args = serde_json::json!([self.id, request_id, payload, true]);
        webview
            .eval(format!(
                "window.__OPENCLAW_NATIVE_NOTIFICATIONS_ADMIT__?.(...{args})"
            ))
            .is_ok()
            && self.is_current()
    }
}

pub(crate) fn replace_view(app: &AppHandle) -> Arc<BridgeView> {
    app.state::<BridgeViews>().replace()
}

#[cfg(test)]
mod tests {
    use super::BridgeViews;

    #[test]
    fn navigation_and_same_label_replacement_revoke_captured_documents() {
        let views = BridgeViews::default();
        let view = views.replace();
        let first = view.document("same-url-document".to_string());
        assert!(first.is_current());
        view.navigated();
        assert!(!first.is_current());
        let reloaded = view.document("same-url-document".to_string());
        assert!(reloaded.is_current());
        let replacement = views.replace().document("same-url-document".to_string());
        assert!(!reloaded.is_current());
        assert!(replacement.is_current());
        views.retire();
        assert!(!replacement.is_current());
    }
}
