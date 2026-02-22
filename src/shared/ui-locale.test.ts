import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUiLocale, resolveUiLocale } from "./ui-locale.js";

test("normalizeUiLocale maps Chinese variants to zh-CN", () => {
  assert.equal(normalizeUiLocale("zh"), "zh-CN");
  assert.equal(normalizeUiLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeUiLocale("zh_cn"), "zh-CN");
});

test("normalizeUiLocale falls back to en for unknown values", () => {
  assert.equal(normalizeUiLocale("fr"), "en");
  assert.equal(normalizeUiLocale(""), "en");
});

test("resolveUiLocale prioritizes env over config", () => {
  const previous = process.env.HIBOSS_UI_LOCALE;
  process.env.HIBOSS_UI_LOCALE = "zh-CN";
  try {
    assert.equal(resolveUiLocale("en"), "zh-CN");
  } finally {
    if (typeof previous === "string") {
      process.env.HIBOSS_UI_LOCALE = previous;
    } else {
      delete process.env.HIBOSS_UI_LOCALE;
    }
  }
});
