import test from "node:test";
import assert from "node:assert/strict";
import { bindCtripLibraryPresentationImages } from "../../src/main/automation/ctrip/presentation/main.js";
import { COVER_IMAGE_TYPE_ID, ATTRACTION_IMAGE_TYPE_ID } from "../../src/main/automation/ctrip/presentation/cover-bind.js";

test("单张景点图不可用时保留警告，继续绑定其它图片并允许图文流程返回", async () => {
  const bound: any[] = [];
  const attempted: number[] = [];
  const page = { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    let payload: any = { ResponseStatus: { Ack: "Success" }, productImages: structuredClone(bound) };
    if (request.body.productImages) {
      const image = request.body.productImages[0];
      attempted.push(image.imageId);
      if (image.imageId === 2) payload = { ResponseStatus: { Ack: "Failure", Errors: [{ Message: "图库图片不存在" }] } };
      else {
        bound.push({ imageInfo: { imageId: image.imageId, accompanyTourInfo: image.accompanyTourInfo } });
        payload = { ResponseStatus: { Ack: "Success" }, success: true };
      }
    }
    return { status: 200, payload, durationMs: 1, ctx: {} as any };
  } };
  const result = await bindCtripLibraryPresentationImages(page, { source: "ctripLibrary", imageId: 1, imageUrl: "https://img/1", poi: "景点甲", alternates: [
    { imageId: 2, imageUrl: "https://img/2", poi: "景点乙" }, { imageId: 3, imageUrl: "https://img/3", poi: "景点丙" },
  ] }, 1);
  assert.deepEqual(attempted, [1, 2, 3]);
  assert.equal(result.imageId, 1);
  assert.deepEqual(result.attractionImages.map((image: any) => image.imageId), [3]);
  assert.equal(result.imageWarnings.length, 1);
  assert.match(result.imageWarnings[0], /景点乙.*图库图片不存在/);
  assert.deepEqual(bound.map(image => image.imageInfo.accompanyTourInfo.imageTypeId), [COVER_IMAGE_TYPE_ID, ATTRACTION_IMAGE_TYPE_ID]);
});
