import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const commandPath = new URL(
  '../contracts/remote-control/v1/fixtures/command.json',
  import.meta.url
)
const eventPath = new URL('../contracts/remote-control/v1/fixtures/event.json', import.meta.url)

test('remote command fixture preserves the v1 envelope', async () => {
  const command = JSON.parse(await readFile(commandPath, 'utf8'))
  assert.equal(command.protocolVersion, '1')
  assert.equal(command.type, 'sessions.prompt')
  assert.equal(command.expectedRevision, 7)
  assert.equal(command.payload.sessionId, 'session-01')
})

test('remote event fixture preserves monotonic sequence metadata', async () => {
  const event = JSON.parse(await readFile(eventPath, 'utf8'))
  assert.equal(event.protocolVersion, '1')
  assert.equal(event.type, 'tasks.changed')
  assert.equal(event.sequence, 42)
  assert.deepEqual(event.payload.taskIds, ['task-01'])
})
