import "@testing-library/jest-dom";
import { TextDecoder, TextEncoder } from "util";

// jsdom provides neither TextEncoder nor TextDecoder, but lib/api.ts's NDJSON
// reader decodes each streamed chunk with TextDecoder -- so without this, the
// upload-progress and analytics-dataset paths simply cannot be unit tested at
// all. Node's implementations are the same ones the browser exposes.
Object.assign(globalThis, { TextDecoder, TextEncoder });
