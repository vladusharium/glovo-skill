import assert from "node:assert/strict";
import { GlovoClient, basketWithQuantity } from "../src/glovo/api.mjs";

function basket() {
  return {
    basketId: "basket/live id",
    basketVersion: "7",
    storeId: 1,
    storeAddressId: 2,
    storeCategoryId: 1,
    handlingStrategy: "DELIVERY",
    status: "IN_PROGRESS",
    basketPrice: { final: { formatted: "9" } },
    products: [
      {
        ids: { basketProductId: "bp/live id", id: "product-1", storeProductId: "store-product-1", externalId: "external-1" },
        quantity: { increments: 2, incrementsLimit: 10 },
        name: "Kept fields",
      },
      {
        ids: { basketProductId: "bp-other", id: "product-2", storeProductId: "store-product-2", externalId: "external-2" },
        quantity: { increments: 1 },
      },
    ],
  };
}

function fakeClient({ stored = basket(), list = [{ storeId: 1, storeAddressId: 2, basketItems: 3 }] } = {}) {
  const client = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
  const calls = [];
  client.getBaskets = async () => {
    calls.push({ kind: "list" });
    return list;
  };
  client.getStoreBasket = async (storeId, storeAddressId) => {
    calls.push({ kind: "get", storeId, storeAddressId });
    return structuredClone(stored);
  };
  client.putBasket = async (basketId, body) => {
    calls.push({ kind: "put", basketId, body });
    return body;
  };
  client.call = async (path, options) => {
    throw new Error(`unexpected raw call ${options?.method} ${path}`);
  };
  return { client, calls };
}

for (const mode of ["removeFromBasket", "setQuantityZero"]) {
  const { client, calls } = fakeClient();
  if (mode === "removeFromBasket") await client.removeFromBasket({ storeId: 1, storeAddressId: 2, basketProductId: "bp/live id" });
  else await client.setQuantity({ storeId: 1, storeAddressId: 2, basketProductId: "bp/live id", quantity: 0 });

  assert.deepEqual(calls.map((call) => call.kind), ["get", "put"], `${mode}: v2 read then whole-basket PUT, no v1 PATCH`);
  const put = calls[1];
  assert.equal(put.basketId, "basket/live id");
  assert.deepEqual(put.body.products.map((line) => line.ids.basketProductId), ["bp-other"], `${mode}: line dropped at zero`);
  assert.equal(put.body.basketVersion, "7");
  assert.deepEqual(put.body.basketPrice, { final: { formatted: "9" } });
}

{
  const { client, calls } = fakeClient();
  await client.setQuantity({ storeId: 1, productId: "product-1", quantity: 5 });
  assert.deepEqual(calls.map((call) => call.kind), ["list", "get", "put"], "missing storeAddressId comes from the basket list");
  assert.deepEqual({ storeId: calls[1].storeId, storeAddressId: calls[1].storeAddressId }, { storeId: 1, storeAddressId: 2 });
  const line = calls[2].body.products.find((entry) => entry.ids.basketProductId === "bp/live id");
  assert.deepEqual(line.quantity, { increments: 5, incrementsLimit: 10 });
  assert.equal(line.name, "Kept fields");
  assert.equal(calls[2].body.products.length, 2);
}

{
  const { client } = fakeClient({ list: [] });
  await assert.rejects(() => client.setQuantity({ storeId: 1, basketProductId: "bp/live id", quantity: 1 }), /No active basket for store 1/);
}

{
  const { client, calls } = fakeClient({ stored: { ...basket(), products: [], status: "DRAFT" } });
  await assert.rejects(() => client.removeFromBasket({ storeId: 1, storeAddressId: 2, basketProductId: "bp/live id" }), /No active basket for store 1/);
  assert.equal(calls.some((call) => call.kind === "put"), false);
}

{
  const { client, calls } = fakeClient();
  await assert.rejects(() => client.removeFromBasket({ storeId: 1, storeAddressId: 2, basketProductId: "bp-missing" }), /Product is not in the basket/);
  assert.equal(calls.some((call) => call.kind === "put"), false);
}

{
  const { client, calls } = fakeClient();
  let puts = 0;
  client.putBasket = async (basketId, body) => {
    puts += 1;
    calls.push({ kind: "put" });
    if (puts === 1) {
      const error = new Error("PUT /v2/baskets/[basket] -> 409: OLD_BASKET_VERSION");
      error.exceptionName = "OLD_BASKET_VERSION";
      throw error;
    }
    return body;
  };
  await client.setQuantity({ storeId: 1, storeAddressId: 2, basketProductId: "bp/live id", quantity: 3 });
  assert.deepEqual(calls.map((call) => call.kind), ["get", "put", "get", "put"], "stale version re-reads once");
}

const original = basket();
const changed = basketWithQuantity(original, "bp-other", 4);
assert.equal(original.products[1].quantity.increments, 1, "basketWithQuantity does not mutate its input");
assert.equal(changed.products[1].quantity.increments, 4);

const pathClient = new GlovoClient("/tmp/unused", { session: { customerId: 123 } });
let callRecord;
pathClient.call = async (path, options) => {
  callRecord = { path, options };
  return null;
};
await pathClient.deleteBasket("basket/live id?x=1");
assert.deepEqual(callRecord, {
  path: "/v2/baskets/basket%2Flive%20id%3Fx%3D1",
  options: { method: "DELETE", auth: true, allowNotFound: true },
});
await pathClient.putBasket("basket/live id", { products: [] });
assert.deepEqual(callRecord, {
  path: "/v2/baskets/basket%2Flive%20id",
  options: { method: "PUT", auth: true, body: { products: [] } },
});

console.log("basket-remove.test: v2 quantity set/remove, address fallback, stale-version retry, and v2 delete contracts passed");
