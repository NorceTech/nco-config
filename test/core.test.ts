import { describe, it, expect } from "vitest";
import { mergePatch, jsonEqual, sortKeys } from "../src/core/mergePatch.js";
import { interpolateJson, interpolateTokens, findSecretRefs, InterpolationError } from "../src/core/interpolate.js";
import { expandChannels, channelNameFor } from "../src/core/matrix.js";
import { channelNameParser, factor } from "../src/core/export.js";
import { diffDocuments } from "../src/core/plan.js";
import { loadCatalog, deriveUrls, applyDerived } from "../src/core/catalog.js";
import { SecretDetector, secretNameFor } from "../src/secrets/detect.js";
import type { NoccConfig } from "../src/core/types.js";

describe("mergePatch", () => {
  it("merges objects, replaces arrays, deletes on null", () => {
    const out = mergePatch({ a: { x: 1, y: 2 }, list: [1, 2], gone: true }, { a: { y: 3, z: 4 }, list: [9], gone: null });
    expect(out).toEqual({ a: { x: 1, y: 3, z: 4 }, list: [9] });
  });
  it("does not mutate inputs", () => {
    const target = { a: { x: 1 } };
    mergePatch(target, { a: { x: 2 } });
    expect(target.a.x).toBe(1);
  });
  it("jsonEqual ignores key order", () => {
    expect(jsonEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(JSON.stringify(sortKeys({ b: 1, a: { d: 1, c: 2 } }))).toBe('{"a":{"c":2,"d":1},"b":1}');
  });
});

describe("interpolation", () => {
  const scope = { tokens: { market: "se", segment: "b2b", env: "qa" }, vars: { frontend: "https://qa.acme.example" }, lookups: { locale: { se: "sv-se" }, walley: { storeId: { stage: { se: { b2b: "6348" } } } } } };
  it("replaces tokens with case modifiers and leaves unknown tokens", () => {
    expect(interpolateTokens("storeId-${MARKET}-${SEGMENT} ${Market} {productId}", scope.tokens, "t")).toBe("storeId-SE-B2B Se {productId}");
  });
  it("resolves var and lookup inside strings and whole-value lookups", () => {
    const out = interpolateJson(
      { url: "${var:frontend}/${lookup:locale.${market}}/checkout", "storeId-${MARKET}-${SEGMENT}": "${lookup:walley.storeId.stage.${market}.${segment}}", secret: "${secret:WALLEY_API_SECRET}" },
      scope,
      "doc",
    );
    expect(out).toEqual({ url: "https://qa.acme.example/sv-se/checkout", "storeId-SE-B2B": "6348", secret: "${secret:WALLEY_API_SECRET}" });
  });
  it("fails loudly on missing lookups", () => {
    expect(() => interpolateJson({ x: "${lookup:walley.storeId.prod.se.b2b}" }, scope, "doc")).toThrow(InterpolationError);
  });
  it("lists secret refs with paths", () => {
    expect(findSecretRefs({ apiSettings: { apiSecret: "${secret:A}", list: [{ k: "${secret:B}" }] } })).toEqual([
      { path: "apiSettings.apiSecret", name: "A" },
      { path: "apiSettings.list[0].k", name: "B" },
    ]);
  });
});

const acme: NoccConfig = {
  merchant: "acme",
  environments: { prod: { target: "prod" }, qa: { target: "stage", channelSuffix: "-qa" } },
  dimensions: { brand: ["acme", "outlet"], market: ["se", "no"], segment: ["b2c", "b2b"] },
  channelName: "${brand}-${market}${segment}",
  channelNameParts: { segment: { b2c: "", b2b: "-b2b" } },
  exclude: [{ brand: "outlet", segment: "b2b" }],
  features: { recurring: { brand: "acme", market: "se" } },
  layers: ["layers/base"],
};

describe("matrix", () => {
  it("expands dimensions with exclusions, name parts and features", () => {
    const specs = expandChannels(acme);
    expect(specs.map((s) => s.name)).toEqual(["acme-no", "acme-no-b2b", "acme-se", "acme-se-b2b", "outlet-no", "outlet-se"]);
    expect(specs.find((s) => s.name === "acme-se-b2b")?.features).toEqual(["recurring"]);
    expect(specs.find((s) => s.name === "acme-no")?.features).toEqual([]);
  });
  it("parses names back to dimensions, empty fragment last", () => {
    const parse = channelNameParser(acme.channelName!, acme.dimensions!, acme.channelNameParts);
    expect(parse("acme-se-b2b")).toEqual({ brand: "acme", market: "se", segment: "b2b" });
    expect(parse("acme-se")).toEqual({ brand: "acme", market: "se", segment: "b2c" });
    expect(parse("acme-se-qa")).toBeUndefined();
    expect(channelNameFor(acme.channelName!, { brand: "acme", market: "se", segment: "b2c" }, acme.channelNameParts)).toBe("acme-se");
  });
});

describe("factor", () => {
  it("places constants in base, per-dimension values in dimension layers, rest per channel", () => {
    const mk = (channel: string, dims: Record<string, string>, country: string, customerType: string, appId: number) => ({
      channel,
      dims,
      documents: [{ id: "norce_adapter", active: true, country: { defaultCountry: country }, order: { customerType }, settings: { applicationId: appId, clientId: 42 } }],
    });
    const f = factor(
      [
        mk("acme-se", { market: "se", segment: "b2c" }, "SE", "Person", 1),
        mk("acme-se-b2b", { market: "se", segment: "b2b" }, "SE", "Company", 2),
        mk("acme-no", { market: "no", segment: "b2c" }, "NO", "Person", 3),
        mk("acme-no-b2b", { market: "no", segment: "b2b" }, "NO", "Company", 4),
      ],
      ["market", "segment"],
    );
    expect(f.base.get("norce_adapter")).toEqual({ active: true, settings: { clientId: 42 } });
    expect(f.perDimension.get("market")?.get("no")?.get("norce_adapter")).toEqual({ country: { defaultCountry: "NO" } });
    expect(f.perDimension.get("segment")?.get("b2b")?.get("norce_adapter")).toEqual({ order: { customerType: "Company" } });
    expect(f.perChannel.get("acme-no-b2b")?.get("norce_adapter")).toEqual({ settings: { applicationId: 4 } });
  });
});

describe("plan diff", () => {
  it("reports field-level changes and marks secrets", () => {
    const changes = diffDocuments(
      { id: "x", apiSettings: { apiSecret: "old", storeId: "1" }, options: { a: true } },
      { id: "x", apiSettings: { apiSecret: "new", storeId: "1" }, options: { a: false, b: 1 } },
      (p) => p.endsWith("Secret"),
    );
    expect(changes.map((c) => [c.path, c.secret])).toEqual([
      ["apiSettings.apiSecret", true],
      ["options.a", false],
      ["options.b", false],
    ]);
  });
});

describe("catalog", () => {
  const catalog = loadCatalog();
  it("derives public/internal/schema urls by convention", () => {
    expect(deriveUrls(catalog, "stage", "acme", "walley_checkout_adapter")).toEqual({
      schema: "https://acme.api-se.stage.norce.tech/checkout/walley-adapter/openapi/v1/schemas/walley_checkout_adapter.json",
      adapter: { internalUrl: "https://walley-adapter.checkout.stage.internal.norce.tech", publicUrl: "https://acme.api-se.stage.norce.tech/checkout/walley-adapter" },
    });
    expect(deriveUrls(catalog, "prod", "acme", "norce_adapter").schema).toContain("/openapi/v2/");
    expect(deriveUrls(catalog, "prod", "acme", "stock_validation")).toEqual({ schema: "https://acme.api-se.norce.tech/checkout/configuration/openapi/v1/schemas/configuration.json" });
  });
  it("applyDerived keeps explicit overrides", () => {
    const doc = applyDerived(catalog, "prod", "acme", { id: "ingrid_adapter", adapter: { internalUrl: "https://custom" } });
    expect(doc.adapter).toEqual({ internalUrl: "https://custom", publicUrl: "https://acme.api-se.norce.tech/checkout/ingrid-adapter" });
    expect(doc.active).toBeUndefined();
  });
  it("detects secrets via catalog paths, then key heuristics, never urls", () => {
    const d = new SecretDetector(catalog);
    expect(d.isSecretPath("walley_checkout_adapter", "apiSettings.apiSecret")).toBe(true);
    expect(d.isSecretPath("walley_checkout_adapter", "redirectUrls.merchantTermsUri")).toBe(false);
    expect(d.isSecretPath("unknown_adapter", "settings.password")).toBe(true);
    expect(d.isSecretPath("static_notifications", "order.notifications[2].headers.Authorization")).toBe(true);
    expect(secretNameFor("walley_checkout_adapter", "apiSettings.apiSecret")).toBe("WALLEY_CHECKOUT_ADAPTER_API_SETTINGS_API_SECRET");
  });
});
