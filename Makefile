.DEFAULT_GOAL := help
COMPOSE := docker compose
TEST_COMPOSE := docker compose -p meeting-backend-tests -f docker-compose.test.yml
TEST_DB_PORT ?= 55432
TEST_DATABASE_URL ?= postgres://meeting:meeting@127.0.0.1:$(TEST_DB_PORT)/meeting_test
export TEST_DB_PORT TEST_DATABASE_URL

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n",$$1,$$2}'

install: ## npm install locally
	npm install
dev: ## Run API locally (no docker)
	npm run dev
typecheck: ## Type-check with tsc
	npm run typecheck
test: test-db ## Run tests locally against the isolated test database
	npm test
test-db: ## Start disposable PostgreSQL for tests, separate from the app database
	$(TEST_COMPOSE) up -d --wait db
test-down: ## Stop and discard the isolated test database
	$(TEST_COMPOSE) down
up: ## Start api + db in docker
	$(COMPOSE) up -d --build
down: ## Stop containers
	$(COMPOSE) down
build: ## Build images
	$(COMPOSE) build
logs: ## Follow logs
	$(COMPOSE) logs -f
test-docker: test-db ## Run tests in a container against the isolated test database
	$(TEST_COMPOSE) run --build --rm --no-deps api
clean: ## Remove containers + volumes
	$(COMPOSE) down -v --remove-orphans

.PHONY: help install dev typecheck test test-db test-down up down build logs test-docker clean
