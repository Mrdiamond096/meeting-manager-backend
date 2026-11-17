.DEFAULT_GOAL := help
COMPOSE := docker compose

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n",$$1,$$2}'

install: ## npm install locally
	npm install
dev: ## Run API locally (no docker)
	npm run dev
typecheck: ## Type-check with tsc
	npm run typecheck
test: ## Run tests locally
	npm test
up: ## Start api + db in docker
	$(COMPOSE) up -d --build
down: ## Stop containers
	$(COMPOSE) down
build: ## Build images
	$(COMPOSE) build
logs: ## Follow logs
	$(COMPOSE) logs -f
TEST_DB := meeting_test
test-docker: ## Run tests in a container against the separate meeting_test database (tests truncate every table)
	$(COMPOSE) up -d --wait db
	$(COMPOSE) exec -T db sh -c 'psql -U meeting -tAc "select 1 from pg_database where datname = '"'"'$(TEST_DB)'"'"'" | grep -q 1 || createdb -U meeting $(TEST_DB)'
	$(COMPOSE) run --rm --no-deps -e DATABASE_URL=postgres://meeting:meeting@db:5432/$(TEST_DB) api sh -c 'npx prisma generate >/dev/null && npm test'
clean: ## Remove containers + volumes
	$(COMPOSE) down -v --remove-orphans

.PHONY: help install dev typecheck test up down build logs test-docker clean
