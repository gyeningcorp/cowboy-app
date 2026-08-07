import SwiftUI
import WebKit

struct GameView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.isOpaque = true
        webView.backgroundColor = UIColor(red: 0.102, green: 0.071, blue: 0.063, alpha: 1)

        if let url = Bundle.main.url(forResource: "game", withExtension: "html"),
           let html = try? String(contentsOf: url, encoding: .utf8) {
            webView.loadHTMLString(html, baseURL: Bundle.main.bundleURL)
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
