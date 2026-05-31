api:    mkdir -p tmp/logs && unset PORT && pnpm --filter @superlog/api dev 2>&1 | tee tmp/logs/api.log
web:    mkdir -p tmp/logs && unset PORT && pnpm --filter @superlog/web dev 2>&1 | tee tmp/logs/web.log
worker: mkdir -p tmp/logs && unset PORT && pnpm --filter @superlog/worker dev 2>&1 | tee tmp/logs/worker.log
proxy:  mkdir -p tmp/logs && unset PORT && pnpm --filter @superlog/proxy dev 2>&1 | tee tmp/logs/proxy.log
