.PHONY: start dev lint test build

start:
	pnpm start

dev:
	pnpm dev

lint:
	pnpm --dir apps/web lint

test:
	pnpm --dir apps/web test

build:
	pnpm --dir apps/web build
