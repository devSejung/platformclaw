import { describe, expect, it, vi } from "vitest";
import { SpaceQaPostsState } from "./space-qa-posts.ts";
type SpaceQaPost = SpaceQaPostsState["posts"][number];

const page = { spaceId: "team", id: "issue" };
const post: SpaceQaPost = {
  id: "post-one",
  spaceId: page.spaceId,
  pageId: page.id,
  revision: 1,
  body: "A😀",
  authorId: "alice",
  authorName: "Alice Example",
  agentId: "personal-alice",
  createdAt: 100,
  bodyOffset: 0,
  nextBodyOffset: 3,
  truncated: true,
};
const list = { revision: 1, posts: [post], nextCursor: null };

describe("shared Q&A bounded reads", () => {
  it("continues at the returned UTF-16 offset once per pending click", async () => {
    const state = new SpaceQaPostsState(vi.fn());
    const request = vi.fn().mockResolvedValueOnce(list);
    await state.load(page, request, () => true);
    let release!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const reading = state.readMore(page, state.posts[0]!, request);
    await state.readMore(page, state.posts[0]!, request);
    expect(request.mock.calls).toEqual([
      ["qa.list", { spaceId: "team", pageId: "issue" }],
      ["qa.get", { spaceId: "team", pageId: "issue", postId: post.id, bodyOffset: 3 }],
    ]);
    release({
      revision: 2,
      post: { ...post, body: "B", bodyOffset: 3, nextBodyOffset: null, truncated: false },
    });
    await reading;
    expect(state.posts[0]).toMatchObject({ body: "A😀B", bodyOffset: 0, nextBodyOffset: null });
    expect(state.error).toBe("");
  });

  it.each([
    { id: "other" },
    { revision: 2 },
    { spaceId: "other" },
    { pageId: "other" },
    { bodyOffset: 0 },
    { nextBodyOffset: 3 },
  ])("never joins a changed or noncontiguous continuation %j", async (changed) => {
    const state = new SpaceQaPostsState(vi.fn());
    const request = vi
      .fn()
      .mockResolvedValueOnce(list)
      .mockResolvedValueOnce({
        revision: 1,
        post: {
          ...post,
          body: "unsafe continuation",
          bodyOffset: 3,
          nextBodyOffset: null,
          ...changed,
        },
      });
    await state.load(page, request, () => true);
    await state.readMore(page, post, request);
    expect(state.posts[0]?.body).toBe("A😀");
    expect(state.error).not.toBe("");
  });

  it("retires a late list before dispatching a source-anchor read", async () => {
    const state = new SpaceQaPostsState(vi.fn());
    let release!: (value: unknown) => void;
    const request = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const reading = state.load(page, request, () => true, "outside-first-page");
    state.clear();
    release(list);
    await reading;
    expect(state.posts).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("discards a continuation after access or page selection is retired", async () => {
    const state = new SpaceQaPostsState(vi.fn());
    const request = vi.fn().mockResolvedValueOnce(list);
    await state.load(page, request, () => true);
    let release!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const reading = state.readMore(page, post, request);
    state.clear();
    release({
      revision: 1,
      post: { ...post, body: "retired content", bodyOffset: 3, nextBodyOffset: null },
    });
    await reading;
    expect(state.posts).toEqual([]);
    expect(state.error).toBe("");
  });

  it("reads source anchors outside the initial page and pages only on explicit request", async () => {
    const state = new SpaceQaPostsState(vi.fn());
    const anchored = { ...post, id: "anchored", body: "Full saved answer", nextBodyOffset: null };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...list, nextCursor: "next" })
      .mockResolvedValueOnce({ revision: 1, post: anchored })
      .mockResolvedValueOnce({
        revision: 1,
        posts: [{ ...anchored, body: "Excerpt" }],
        nextCursor: null,
      });
    await state.load(page, request, () => true, anchored.id);
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.posts).toHaveLength(2);
    await state.load(page, request, () => true, "", true);
    expect(request).toHaveBeenLastCalledWith("qa.list", {
      spaceId: "team",
      pageId: "issue",
      cursor: "next",
    });
    expect(state.posts.find((item) => item.id === anchored.id)?.body).toBe("Full saved answer");
    expect(state.nextCursor).toBeNull();
  });
});
