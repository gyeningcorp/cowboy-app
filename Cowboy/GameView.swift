import SwiftUI
import WebKit
import UIKit

struct GameView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        // isOpaque=true forces a WHITE paint until the page renders and ignores
        // backgroundColor — that was the blank-white screen. Keep it transparent
        // so the dark background shows through even before/if the page paints.
        webView.isOpaque = false
        let dark = UIColor(red: 0.102, green: 0.071, blue: 0.063, alpha: 1)
        webView.backgroundColor = dark
        webView.scrollView.backgroundColor = dark

        if let url = Bundle.main.url(forResource: "game", withExtension: "html") {
            // loadFileURL is the reliable path for bundled HTML; localStorage works.
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.loadHTMLString(Coordinator.errorPage("game.html is missing from the app bundle"), baseURL: nil)
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        // WKWebView ignores JS alert()/confirm()/prompt() unless the app implements
        // these. Without them the in-game EXIT confirm() silently returned false and
        // the button did nothing.
        private func topController(_ webView: WKWebView) -> UIViewController? {
            var responder: UIResponder? = webView
            while let r = responder {
                if let vc = r as? UIViewController { return vc }
                responder = r.next
            }
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
            return scene?.keyWindow?.rootViewController
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            topController(webView)?.present(alert, animated: true) ?? completionHandler()
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            if let vc = topController(webView) { vc.present(alert, animated: true) } else { completionHandler(false) }
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler(alert.textFields?.first?.text)
            })
            if let vc = topController(webView) { vc.present(alert, animated: true) } else { completionHandler(nil) }
        }

        static func errorPage(_ msg: String) -> String {
            """
            <html><body style="background:#1a1210;color:#e8c98f;font-family:-apple-system,monospace;\
            display:flex;align-items:center;justify-content:center;height:100vh;margin:0;\
            text-align:center;padding:24px;font-size:16px;line-height:1.6">\(msg)</body></html>
            """
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            webView.loadHTMLString(Self.errorPage("Load error: \(error.localizedDescription)"), baseURL: nil)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            webView.loadHTMLString(Self.errorPage("Load error: \(error.localizedDescription)"), baseURL: nil)
        }
    }
}
