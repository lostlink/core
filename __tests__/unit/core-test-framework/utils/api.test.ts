import "jest-extended";

import { Identifiers } from "@packages/core-api/src";
import { CryptoSuite } from "@packages/core-crypto";
import { Sandbox } from "@packages/core-test-framework/src";
import { ApiHelpers } from "@packages/core-test-framework/src/utils/api";

import {
    blockResponse,
    delegateResponse,
    lockResponse,
    paginationResponseMeta,
    transactionResponse,
    walletResponse,
} from "./__fixtures__/assets";

let sandbox: Sandbox;
let api: ApiHelpers;

const mockResponse: any = '{test:"test"}';

const crypto = new CryptoSuite.CryptoSuite();

const mockServer = {
    async inject(options: any) {
        return mockResponse;
    },
};

beforeEach(async () => {
    sandbox = new Sandbox(crypto as any);

    sandbox.app.bind(Identifiers.HTTP).toConstantValue(mockServer);

    api = new ApiHelpers(crypto, sandbox.app);
});

afterEach(() => {
    jest.resetAllMocks();
});

describe("ApiHelpers", () => {
    describe("request", () => {
        it("should return response", async () => {
            const response = await api.request("GET", "blockchain", "dummy_params", {});
            expect(response).toBe(response);
        });

        it("should return response", async () => {
            const response = await api.request("POST", "blockchain", "dummy_params", {});
            expect(response).toBe(response);
        });

        it("should return response - without params", async () => {
            const response = await api.request("POST", "blockchain");
            expect(response).toBe(response);
        });
    });

    describe("expectJson", () => {
        it("should pass", async () => {
            const response = {
                data: {},
            };

            api.expectJson(response);
        });
    });

    describe("expectStatus", () => {
        it("should pass", async () => {
            const response = {
                status: 200,
            };

            api.expectStatus(response, 200);
        });
    });

    describe("expectResource", () => {
        it("should pass", async () => {
            const response = {
                data: {
                    data: {},
                },
            };

            api.expectResource(response);
        });
    });

    describe("expectCollection", () => {
        it("should pass", async () => {
            const response = {
                data: {
                    data: [],
                },
            };

            api.expectCollection(response);
        });
    });

    describe("expectPaginator", () => {
        it("should pass", async () => {
            const response = {
                data: {
                    meta: paginationResponseMeta,
                },
            };

            api.expectPaginator(response);
        });
    });

    describe("expectSuccessful", () => {
        it("should pass", async () => {
            const response = {
                data: {},
                status: 200,
            };

            api.expectSuccessful(response);
        });
    });

    describe("expectError", () => {
        it("should pass", async () => {
            const response = {
                data: {
                    statusCode: 404,
                    error: "Dummy error",
                    message: "Dummy error message",
                },
                status: 404,
            };

            api.expectError(response);
        });
    });

    describe("expectTransaction", () => {
        it("should pass", async () => {
            api.expectTransaction(transactionResponse);
        });
    });

    describe("expectBlock", () => {
        it("should pass", async () => {
            api.expectBlock(blockResponse);
        });

        it("should pass with expected", async () => {
            api.expectBlock(blockResponse, blockResponse);
        });
    });

    describe("expectDelegate", () => {
        it("should pass", async () => {
            api.expectDelegate(delegateResponse);
        });
        it("should pass with expected", async () => {
            api.expectDelegate(delegateResponse, delegateResponse);
        });
    });

    describe("expectWallet", () => {
        it("should pass", async () => {
            // TODO: Check why is vote required

            api.expectWallet(walletResponse);
        });
    });

    describe("expectLock", () => {
        it("should pass", async () => {
            api.expectLock(lockResponse);
        });
    });

    describe("createTransfer", () => {
        it("should create transfer transaction", async () => {
            // @ts-ignore
            const spyOnRequest = jest.spyOn(api, "request");

            const transaction = await api.createTransfer();

            expect(transaction).toBeObject();
            expect(transaction.id).toBeDefined();
            expect(transaction.signature).toBeDefined();
            expect(transaction.version).toBeDefined();
            expect(transaction.type).toBeDefined();
            expect(transaction.typeGroup).toBeDefined();
            expect(transaction.fee).toBeDefined();
            expect(transaction.amount).toBeDefined();
            expect(transaction.nonce).toBeDefined();
            expect(transaction.recipientId).toBeDefined();

            expect(spyOnRequest).toHaveBeenCalled();
        });
    });
});
