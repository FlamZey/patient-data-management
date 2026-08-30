import "@testing-library/jest-dom";
import { TextDecoder, TextEncoder } from "util";

// jsdom provides neither TextEncoder nor TextDecoder, but lib/api.ts's NDJSON
// reader decodes each streamed chunk with TextDecoder -- so without this, the
// upload-progress and analytics-dataset paths simply cannot be unit tested at
// all. Node's implementations are the same ones the browser exposes.
Object.assign(globalThis, { TextDecoder, TextEncoder });

// jsdom ships no layout engine, and therefore no scrolling: it defines
// Element.prototype.scroll/scrollBy/scrollTo not at all, and window's
// equivalents only as stubs that report "Not implemented: Window's
// scrollBy() method" through the virtual console. Components that scroll do
// so legitimately (DataTableCard reveals a row's detail panel in both the
// table's own scroll area and the page; OverlayScrollbar drives the page
// from its keyboard handlers), so give jsdom the missing surface here rather
// than in each test file that happens to render one of them.
//
// These are no-ops because there is genuinely no viewport to move -- but
// they are real, callable methods, which is what lets a test that cares
// about the scrolling spy on one (jest.spyOn) and assert the offsets it was
// asked to scroll by. Silencing the message without providing the method
// would take that away.
for (const name of ["scroll", "scrollBy", "scrollTo"]) {
  Element.prototype[name] = function noopScroll() {};
  window[name] = function noopScroll() {};
}
