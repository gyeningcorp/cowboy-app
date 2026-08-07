import SwiftUI
import WebKit

struct GameView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
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

    class Coordinator: NSObject, WKNavigationDelegate {
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
