import { startProtocolStub } from "../src/lib/protocolStub.ts"

const port = Number(process.env.STUB_PORT ?? 18787)
const stub = await startProtocolStub(port)
console.log(`[protocol-stub] listening on ${stub.baseUrl}`)
