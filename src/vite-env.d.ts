/// <reference types="vite/client" />

// Electron's <webview> is a custom element, so React/TS need to be told it
// exists before the preview panel can render one. Only the attributes the
// preview actually sets are listed.
declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
        useragent?: string;
        webpreferences?: string;
      },
      HTMLElement
    >;
  }
}
