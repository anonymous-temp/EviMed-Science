// A fake of the vendor's 「开放平台API」 on 127.0.0.1, speaking the documented
// shapes (outputs/2026-09-25-geo-build/media-api): multipart POSTs with
// `api_key` in the form, the `{code, msg, time, data}` envelope, both product
// lines (`/api/media/*`, `/api/zi_media_api/*`), the balance and the 查收录
// trio. It keeps its own orders and balance, charges at send (prepaid), and
// returns the money on a refund — so the market's balance arithmetic is
// checked against a counterparty that moves money the way the vendor does.
import http from "node:http";

const PREFIXES = { "/api/media": "website", "/api/zi_media_api": "wemedia" };

/** The vendor's documented `get_field` names for field_1, plus a made-up field_5 naming indexing. */
export const FAKE_FIELDS = {
  field_1: [
    { field_id: "1006", field_type: "field_1", field_title: "新闻资讯", rsort: 6 },
    { field_id: "1007", field_type: "field_1", field_title: "健康医疗", rsort: 7 },
    { field_id: "1014", field_type: "field_1", field_title: "生活消费", rsort: 14 },
  ],
  field_5: [
    { field_id: "5001", field_type: "field_5", field_title: "百度新闻源", rsort: 1 },
    { field_id: "5002", field_type: "field_5", field_title: "网页收录", rsort: 2 },
  ],
};

/** A catalogue row in the vendor's shape. @param {Record<string, any>} overrides */
export function vendorRow(overrides) {
  return {
    resource_id: 1, title: "某健康网", remarks: "", case_link: "https://www.health-a.cn/news/1.html",
    field_1: "1007", field_3: "3001", field_5: "5001", field_6: "6001", pc_weigh: "3", wap_weigh: "3", publish_rate: "85",
    publish_time: 7200, field_2: null, field_4: "4001", field_7: "7024", field_8: null, field_9: "", status: 1, price: "100.00",
    ...overrides,
  };
}

/**
 * @param {{ apiKey?: string, catalogue?: { website?: any[], wemedia?: any[] }, fields?: Record<string, any[]>, balance?: number,
 *   powerCount?: number }} [options]
 */
export async function startFakeMediaMarket({ apiKey = "fake-key-0123456789", catalogue = {}, fields = FAKE_FIELDS, balance = 1_000,
  powerCount = 100 } = {}) {
  const state = {
    apiKey,
    catalogue: { website: catalogue.website ?? [], wemedia: catalogue.wemedia ?? [] },
    fields,
    balance: { money: balance, power_count: powerCount },
    /** @type {Map<string, any>} */
    orders: new Map(),
    /** @type {Map<string, any>} */
    tasks: new Map(),
    /** @type {Array<{ path: string, form: Record<string, string | string[]> }>} */
    requests: [],
    /** Behaviour of the next sends: "ok" | "refuse" | "timeout" | "http500" | "echo_key". */
    sendMode: "ok",
    /** Answer of get_balance: "ok" | "http503". */
    balanceMode: "ok",
    nextNid: 2026092500001,
    appeals: /** @type {any[]} */ ([]),
    /** @type {Set<import("node:http").ServerResponse>} */
    hanging: new Set(),
  };

  const envelope = (/** @type {number} */ code, /** @type {string} */ msg, /** @type {any} */ data) =>
    JSON.stringify({ code, msg, time: String(Math.floor(Date.now() / 1000)), data });

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let form;
    try {
      form = await new Request("http://fake.local/", { method: "POST", headers: { "content-type": String(req.headers["content-type"] ?? "") }, body }).formData();
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(envelope(0, "bad form", null));
      return;
    }
    /** @type {Record<string, string | string[]>} */
    const fieldsSeen = {};
    for (const [name, value] of form.entries()) {
      const text = String(value);
      if (name.endsWith("[]")) fieldsSeen[name] = [...(/** @type {string[]} */ (fieldsSeen[name]) ?? []), text];
      else fieldsSeen[name] = text;
    }
    const path = String(req.url ?? "");
    state.requests.push({ path, form: fieldsSeen });
    const reply = (/** @type {number} */ code, /** @type {string} */ msg, /** @type {any} */ data = null) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(envelope(code, msg, data));
    };
    if (fieldsSeen.api_key !== state.apiKey) { reply(0, "api_key 无效"); return; }
    const prefix = Object.keys(PREFIXES).find((candidate) => path.startsWith(`${candidate}/`));
    const mediaType = prefix ? PREFIXES[/** @type {keyof typeof PREFIXES} */ (prefix)] : null;
    const op = prefix ? path.slice(prefix.length + 1) : path;
    if (mediaType && op === "media_list") {
      const page = Number(fieldsSeen.page);
      const size = Number(fieldsSeen.page_size);
      const rows = state.catalogue[/** @type {"website" | "wemedia"} */ (mediaType)];
      reply(1, "获取成功", rows.slice((page - 1) * size, page * size));
      return;
    }
    if (mediaType && op === "get_field") {
      reply(1, "获取成功", state.fields[String(fieldsSeen.field_type)] ?? []);
      return;
    }
    if (mediaType && op === "send") {
      const mode = state.sendMode;
      const row = state.catalogue[/** @type {"website" | "wemedia"} */ (mediaType)].find((item) => String(item.resource_id) === String(fieldsSeen.resource_id));
      if (mode === "refuse") { reply(0, "该媒体不接医疗类稿件"); return; }
      if (mode === "echo_key") { reply(0, `投稿失败：api_key=${state.apiKey} 无权限`); return; }
      if (!row) { reply(0, "媒体资源不存在"); return; }
      const nid = state.nextNid;
      state.nextNid += 1;
      const price = Number(row.price);
      state.balance.money = Math.round((state.balance.money - price) * 100) / 100;
      state.orders.set(String(nid), {
        mediaType, order_nid: String(nid), resource_id: String(row.resource_id), status: 0, price: row.price, is_refund: 0,
        title: String(fieldsSeen.title), remark: String(fieldsSeen.remark ?? ""), content: String(fieldsSeen.content), third_id: String(fieldsSeen.third_id),
        rejection_info: "", refund_info: "", rewrite_info: "", order_url: "",
      });
      if (mode === "timeout") { state.hanging.add(res); return; }
      if (mode === "http500") { res.writeHead(500); res.end("upstream error"); return; }
      reply(1, "投稿成功", { order_nid: nid });
      return;
    }
    if (mediaType && op === "order_info") {
      const nids = [...(/** @type {string[]} */ (fieldsSeen["order_nids[]"]) ?? []), ...(typeof fieldsSeen.order_nids === "string" ? [fieldsSeen.order_nids] : [])];
      const rows = nids.map((nid) => state.orders.get(nid)).filter((order) => order && order.mediaType === mediaType)
        .map(({ mediaType: _type, content: _content, third_id: _third, ...order }) => order);
      // The documented example answers one order as an object.
      reply(1, "获取成功", rows.length === 1 ? rows[0] : rows);
      return;
    }
    if (mediaType && op === "cancel_order") {
      const order = state.orders.get(String(fieldsSeen.order_nid));
      if (!order || order.status !== 0) { reply(0, "投稿订单不存在或条件不符合"); return; }
      order.status = 4;
      order.refund_info = "用户取消";
      refund(order.order_nid);
      reply(1, "取消成功");
      return;
    }
    if (mediaType && op === "rejection") {
      const order = state.orders.get(String(fieldsSeen.order_nid));
      if (!order || order.status !== 2) { reply(0, "申诉失败：没有找到稿件或稿件不符合条件"); return; }
      state.appeals.push({ order_nid: order.order_nid, title_id: Number(fieldsSeen.title_id), info: String(fieldsSeen.info ?? "") });
      order.status = 9;
      reply(1, "申诉成功");
      return;
    }
    if (path === "/api/geo/get_balance") {
      if (state.balanceMode === "http503") { res.writeHead(503); res.end("busy"); return; }
      reply(1, "获取成功", { ...state.balance });
      return;
    }
    if (path === "/api/geo/add_shoulu") {
      const id = `rq${state.tasks.size + 1}`;
      state.balance.power_count -= 1;
      state.tasks.set(id, { request_id: id, platform: Number(fieldsSeen.platform), question: String(fieldsSeen.question), hit_word: String(fieldsSeen.keywords),
        status: 0, keyword_res: "", img_url: "", share_url: "", shoulu_date: "", script_time: 0 });
      reply(1, "添加任务成功，请耐心等待查询结果", { request_id: id });
      return;
    }
    if (path === "/api/geo/check_task") {
      const task = state.tasks.get(String(fieldsSeen.request_id));
      if (!task) { reply(0, "任务不存在"); return; }
      reply(1, "查询成功", task);
      return;
    }
    if (path === "/api/geo/cancel_task") {
      const ids = /** @type {string[]} */ (fieldsSeen["request_ids[]"]) ?? [];
      const cancelled = ids.filter((id) => state.tasks.get(id)?.status === 0);
      if (!cancelled.length) { reply(0, "任务已进入排队查询或已查询完成，不支持退款"); return; }
      for (const id of cancelled) { state.tasks.delete(id); state.balance.power_count += 1; }
      reply(1, "取消成功", cancelled);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(envelope(0, "not found", null));
  });

  /** Return an order's money to the balance and flag it. @param {string} nid @param {{ moveMoney?: boolean }} [options] */
  function refund(nid, { moveMoney = true } = {}) {
    const order = state.orders.get(String(nid));
    if (!order) throw new Error(`no order ${nid}`);
    order.is_refund = 1;
    if (moveMoney) state.balance.money = Math.round((state.balance.money + Number(order.price)) * 100) / 100;
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    /** @param {string} nid @param {Record<string, any>} change */
    setOrder(nid, change) {
      const order = state.orders.get(String(nid));
      if (!order) throw new Error(`no order ${nid}`);
      Object.assign(order, change);
    },
    refund,
    /** Money the vendor moves without an order (a fee, a correction). @param {number} amount */
    adjustBalance(amount) { state.balance.money = Math.round((state.balance.money + amount) * 100) / 100; },
    /** @param {string} prefix */
    requestsTo(prefix) { return state.requests.filter((request) => request.path.startsWith(prefix)); },
    async close() {
      for (const res of state.hanging) res.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
