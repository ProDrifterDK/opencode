export type CompletionIdentity = {
  teamID: string
  engineerID: string
  taskID: string
}

export const completionKey = (input: CompletionIdentity) =>
  `${input.teamID}:${input.engineerID}:${input.taskID}`

export function rememberCompletion(seen: Set<string>, input: CompletionIdentity) {
  const key = completionKey(input)
  if (seen.has(key)) return { kind: "duplicate" as const, key }
  seen.add(key)
  return { kind: "new" as const, key }
}

export * as CompletionDeduper from "./completion-deduper"
