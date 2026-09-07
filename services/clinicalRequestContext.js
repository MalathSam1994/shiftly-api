// Request-local audit metadata. It is not an authorization mechanism.
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();

function clinicalRequestContext(req, res, next) {
  const supplied = req.get('X-Clinical-Source');
  const source = ['Web', 'Mobile', 'Desktop'].includes(supplied) ? supplied : 'Unknown';
  context.run({ source, get actor() { return Number(req.user?.sub ?? req.user?.id) || null; },
    writing: !['GET', 'HEAD', 'OPTIONS'].includes(req.method) }, next);
}

async function setContext(client, metadata) {
  await client.query(
    "SELECT set_config('shiftly.clinical_source', $1, true), set_config('shiftly.clinical_actor', $2, true)",
    [metadata.source, metadata.actor == null ? '' : String(metadata.actor)],
  );
}

// Only this router uses the adapter; read-only requests retain normal pooling.
// SET LOCAL is bound to the same connection/transaction as the clinical write,
// including writes and audit rows created inside PostgreSQL functions/triggers.
function clinicalPool(base) {
  return {
    async query(...args) {
      const metadata = context.getStore();
      if (!metadata?.writing) return base.query(...args);
      const client = await base.connect();
      try {
        await client.query('BEGIN');
        await setContext(client, metadata);
        const result = await client.query(...args);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async connect() {
      const client = await base.connect();
      const metadata = context.getStore();
      return {
        async query(...args) {
          const result = await client.query(...args);
          if (metadata?.writing && /^\s*BEGIN\s*;?\s*$/i.test(String(args[0]))) {
            await setContext(client, metadata);
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  };
}

module.exports = { clinicalRequestContext, clinicalPool };
