# TODO before publishing 0.3.0

## Must do

- [x] Re-stage `src/runtime.ts` — `chunks[]`/`joinedCacheLength` double storage was already cleaned up in HEAD; staged diff is only the `DONE_SENTINEL_TTL` change
- [ ] Add 0.3.0 changelog entry to `README.md`

## Nice to have

- [ ] Prune dead listeners using `PUBLISH` return value — Redis returns 0 when no subscriber received the message, so dead channels can be removed automatically instead of waiting for the cap:
  ```typescript
  const results = await Promise.all(
    listenerChannels.map((id) =>
      ctx.publisher.publish(`${ctx.keyPrefix}:chunk:${id}`, value)
    )
  );
  listenerChannels = listenerChannels.filter((_, i) => results[i] !== 0);
  ```
