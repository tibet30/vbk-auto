import test from "node:test";
import assert from "node:assert/strict";

import {
  assertVbkAckSuccess,
  describeVbkFailureDetail,
  vbkResponseAck,
} from "../../src/main/infrastructure/vbk-response-error.js";

test("VBK 错误摘要提取平台返回的 Code 和 Message", () => {
  const payload = {
    ResponseStatus: {
      Ack: "Failure",
      Errors: [
        { ErrorCode: "40010001", Message: "没有当前资源的权限" },
        { Code: "IMG_BIND_FAIL", message: "图片不属于当前供应商" },
      ],
    },
    errorMsg: "绑定失败",
  };

  assert.equal(vbkResponseAck(payload), "Failure");
  assert.equal(
    describeVbkFailureDetail(payload),
    "40010001: 没有当前资源的权限；IMG_BIND_FAIL: 图片不属于当前供应商；绑定失败",
  );
  assert.throws(
    () => assertVbkAckSuccess(payload, "直接设置产品封面"),
    /直接设置产品封面失败（Ack=Failure）：40010001: 没有当前资源的权限/,
  );
});

test("VBK 错误摘要兼容顶层 message，并压平成单行", () => {
  assert.equal(
    describeVbkFailureDetail({
      responseStatus: { Ack: "Warning", Errors: [{ message: "第一行\n第二行" }] },
      message: "第一行 第二行",
    }),
    "第一行 第二行",
  );
});
