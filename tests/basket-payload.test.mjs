import assert from "node:assert/strict";
import { GlovoClient } from "../src/glovo/api.mjs";

const draftBasket = () => ({ basketId: "draft-basket-1", basketVersion: null, handlingStrategy: "DELIVERY", customerId: 1, storeId: 1, storeAddressId: 2, storeCategoryId: null, products: [], status: "DRAFT" });

const missingStoreProduct = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
missingStoreProduct.getStoreBasket = async () => draftBasket();
missingStoreProduct.call = async () => {
  throw new Error("POST should not be reached");
};
await assert.rejects(
  () =>
    missingStoreProduct.addToBasket({
      storeId: "store-1",
      storeAddressId: "address-1",
      storeCategoryId: 99,
      productId: 12345,
      externalId: "external-abc",
    }),
  /storeProductId is required/,
);

const missingCategory = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
missingCategory.getStoreBasket = async () => draftBasket();
missingCategory.call = async () => {
  throw new Error("POST should not be reached");
};
await assert.rejects(
  () =>
    missingCategory.addToBasket({
      storeId: "store-1",
      storeAddressId: "address-1",
      productId: 12345,
      externalId: "external-abc",
      storeProductId: "store-product-xyz",
    }),
  /storeCategoryId is required/,
);

const missingProduct = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
missingProduct.getStoreBasket = async () => draftBasket();
missingProduct.call = async () => {
  throw new Error("POST should not be reached");
};
await assert.rejects(
  () =>
    missingProduct.addToBasket({
      storeId: "store-1",
      storeAddressId: "address-1",
      storeCategoryId: 99,
      externalId: "external-abc",
      storeProductId: "store-product-xyz",
    }),
  /productId is required/,
);

const missingExternal = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
missingExternal.getStoreBasket = async () => draftBasket();
missingExternal.call = async () => {
  throw new Error("POST should not be reached");
};
await assert.rejects(
  () =>
    missingExternal.addToBasket({
      storeId: "store-1",
      storeAddressId: "address-1",
      storeCategoryId: 99,
      productId: 12345,
      storeProductId: "store-product-xyz",
    }),
  /externalId is required/,
);

const missingCustomizationField = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
missingCustomizationField.getStoreBasket = async () => {
  throw new Error("basket lookup should not be reached");
};
missingCustomizationField.call = async () => {
  throw new Error("POST should not be reached");
};
await assert.rejects(
  () =>
    missingCustomizationField.addToBasket({
      storeId: "store-1",
      storeAddressId: "address-1",
      storeCategoryId: 99,
      productId: 12345,
      externalId: "external-abc",
      storeProductId: "store-product-xyz",
      selectedOptions: [{ group_id: 701, option_id: 801, quantity: 1 }],
      productView: {
        data: {
          metadata: {
            product: {
              attributeGroups: [
                {
                  id: 701,
                  attributeGroupId: "group-stable-701",
                  position: 3,
                  name: "Size",
                  min: 1,
                  max: 1,
                  attributes: [
                    {
                      id: 801,
                      attributeId: "option-stable-801",
                      externalId: "option-external-801",
                      name: "Medium",
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    }),
  /Missing groupExternalId/,
);

const client = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
client.getStoreBasket = async () => draftBasket();
let captured;
let capturedCall;
client.call = async (path, options) => {
  captured = options.body;
  capturedCall = { path, method: options.method, auth: options.auth };
  return { ok: true };
};

await client.addToBasket({
  storeId: "store-1",
  storeAddressId: "address-1",
  storeCategoryId: 99,
  productId: 12345,
  externalId: "external-abc",
  storeProductId: "store-product-xyz",
  quantity: 2,
  selectedOptions: [{ group_id: 701, option_id: 801, quantity: 1 }],
  productView: {
    data: {
      metadata: {
        product: {
          attributeGroups: [
            {
              id: 701,
              attributeGroupId: "group-stable-701",
              externalId: "group-external-701",
              position: 3,
              name: "Size",
              min: 1,
              max: 1,
              attributes: [
                {
                  id: 801,
                  attributeId: "option-stable-801",
                  externalId: "option-external-801",
                  name: "Medium",
                },
              ],
            },
          ],
        },
      },
    },
  },
});

const product = captured.products[0];
assert.deepEqual(product.ids, {
  id: "12345",
  externalId: "external-abc",
  storeProductId: "store-product-xyz",
});
assert.equal("legacyId" in product.ids, false);
assert.notEqual(product.ids.id, product.ids.externalId);
assert.notEqual(product.ids.id, product.ids.storeProductId);
assert.notEqual(product.ids.externalId, product.ids.storeProductId);
assert.equal(product.quantity.increments, 2);
assert.deepEqual(product.customizations, [
  {
    ids: {
      groupLegacyId: 701,
      groupId: "group-stable-701",
      groupExternalId: "group-external-701",
      groupPosition: 3,
      legacyId: 801,
      id: "option-stable-801",
      externalId: "option-external-801",
    },
    name: "Medium",
    quantity: { increments: 1 },
    customizationName: "Medium",
    groupName: "Size",
  },
]);
assert.equal(product.attributes, undefined);
assert.equal(captured.storeCategoryId, 99);
assert.deepEqual(capturedCall, { path: "/v2/baskets/draft-basket-1", method: "PUT", auth: true });
assert.equal(captured.basketId, "draft-basket-1");
assert.equal(captured.handlingStrategy, "DELIVERY");

const v2Client = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
let v2Paths = [];
v2Client.ensureAuth = async () => "token";
v2Client.send = async (path, { method }) => {
  v2Paths.push(`${method} ${path}`);
  return { ok: true, status: 200, text: JSON.stringify(draftBasket()) };
};
await v2Client.getStoreBasket("store 1", 22);
assert.deepEqual(v2Paths, ["GET /v2/baskets/stores/store%201?storeAddressId=22"]);

const existingLine = () => ({
  ids: { basketProductId: "bp-1", id: "12345", externalId: "external-abc", storeProductId: "store-product-xyz" },
  quantity: { increments: 1, incrementsLimit: 10 },
  customizations: [],
  name: "Existing",
});
const existingBasket = () => ({ ...draftBasket(), basketVersion: "v1", storeCategoryId: 0, status: "IN_PROGRESS", products: [existingLine()], basketPrice: { final: { formatted: "1" } } });

const mergeClient = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
const original = existingBasket();
mergeClient.getStoreBasket = async () => original;
let mergeBody;
mergeClient.call = async (_path, options) => {
  mergeBody = options.body;
  return options.body;
};
await mergeClient.addToBasket({ storeId: 1, storeAddressId: 2, productId: 12345, externalId: "external-abc", storeProductId: "store-product-xyz", quantity: 2 });
assert.equal(mergeBody.products.length, 1, "same product without options bumps the existing line");
assert.equal(mergeBody.products[0].quantity.increments, 3);
assert.equal(mergeBody.products[0].quantity.incrementsLimit, 10);
assert.equal(mergeBody.products[0].ids.basketProductId, "bp-1");
assert.equal(mergeBody.storeCategoryId, 0, "existing basket category is left untouched");
assert.equal(mergeBody.basketVersion, "v1");
assert.deepEqual(mergeBody.basketPrice, { final: { formatted: "1" } });
assert.equal(original.products[0].quantity.increments, 1, "fetched basket is not mutated");

await mergeClient.addToBasket({ storeId: 1, storeAddressId: 2, productId: 777, externalId: "external-777", storeProductId: "store-product-777" });
assert.equal(mergeBody.products.length, 2, "a different product becomes a new line");
assert.deepEqual(mergeBody.products[1], { ids: { id: "777", externalId: "external-777", storeProductId: "store-product-777" }, quantity: { increments: 1 } });

const staleClient = new GlovoClient("/tmp/unused", { session: { customerId: 1 } });
let staleReads = 0;
let stalePuts = 0;
staleClient.getStoreBasket = async () => {
  staleReads += 1;
  return existingBasket();
};
staleClient.call = async () => {
  stalePuts += 1;
  const error = new Error("PUT /v2/baskets/[basket] -> 409: OLD_BASKET_VERSION");
  error.exceptionName = "OLD_BASKET_VERSION";
  throw error;
};
await assert.rejects(
  () => staleClient.addToBasket({ storeId: 1, storeAddressId: 2, productId: 777, externalId: "external-777", storeProductId: "store-product-777" }),
  /OLD_BASKET_VERSION/,
);
assert.equal(staleReads, 2, "stale basket version re-reads the basket once");
assert.equal(stalePuts, 2, "stale basket version retries the PUT once, then gives up");

const deleteClient = new GlovoClient("/tmp/unused", { session: { customerId: 123 } });
let deleteCall;
deleteClient.call = async (path, options) => {
  deleteCall = { path, options };
  return null;
};
await deleteClient.deleteBasket("basket/live id?x=1");
assert.deepEqual(deleteCall, {
  path: "/v2/baskets/basket%2Flive%20id%3Fx%3D1",
  options: {
    method: "DELETE",
    auth: true,
    allowNotFound: true,
  },
});

console.log("basket-payload.test: v2 basket PUT keeps distinct identifiers, category, customizations, and line merging");
