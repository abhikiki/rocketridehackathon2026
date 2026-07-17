# Seeded bug — ground truth

`GET /users/:id` in `src/app.js` does:

```js
const user = USERS[req.params.id];
res.json({ id: user.id, name: user.name });
```

`USERS[req.params.id]` is `undefined` for any id not in the mock table
(anything other than `'1'` or `'2'`). Reading `.name` off `undefined` throws
a `TypeError`, which the Express error handler catches and reports.

## Correct fix

```js
const user = USERS[req.params.id];
if (!user) {
  return res.status(404).json({ error: 'User not found' });
}
res.json({ id: user.id, name: user.name });
```

Used later (Pipeline 3 / demo Session 8) to grade the AI-generated PR
against this ground truth: it should add the same null check and 404
response, not something structurally different (e.g. wrapping in try/catch
and swallowing the error, or returning a 200 with a null body).
