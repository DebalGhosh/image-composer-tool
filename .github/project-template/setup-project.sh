#!/usr/bin/env bash
# =============================================================================
# GitHub Project Setup Script
# =============================================================================
# Creates a fully configured GitHub Project with board columns, custom fields,
# labels, and milestones. Based on the GSoC 2026 - Image Composer Tool Web UI
# project setup.
#
# Usage:
#   ./setup-project.sh --org <org> --repo <repo> --title <title> [options]
#
# Example:
#   ./setup-project.sh \
#     --org open-edge-platform \
#     --repo image-composer-tool \
#     --title "GSoC 2026 - Image Composer Tool Web UI" \
#     --prefix "ICT_GSoC_2026"
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - Token scopes: repo, project, read:org
#   - SSO authorized for the organization (if applicable)
#
# What it creates:
#   1. GitHub Project (linked to repo)
#   2. Board columns (Status field): Backlog, This Week, In Progress, In Review, Done, Blocked
#   3. Custom fields: Priority, Component, Week, Sprint
#   4. Repository labels (20 labels for project management)
#   5. Repository milestones (13 weeks + 2 demo milestones)
# =============================================================================

set -euo pipefail

# --- Configuration (edit these or pass via flags) ----------------------------

ORG=""
REPO=""
PROJECT_TITLE=""
MILESTONE_PREFIX=""
PROJECT_DESCRIPTION=""
README_FILE=""
SPRINT_START_DATE=""
SPRINT_DURATION=14
SPRINT_COUNT=7
DRY_RUN=false

# --- Parse arguments ---------------------------------------------------------

usage() {
    cat <<EOF
Usage: $(basename "$0") [options]

Required:
  --org <org>           GitHub organization name
  --repo <repo>         Repository name (without org prefix)
  --title <title>       Project title

Optional:
  --prefix <prefix>     Milestone prefix (e.g., "ICT_GSoC_2026")
  --description <desc>  Project short description
  --readme <file>       Path to README markdown file for the project
  --sprint-start <date> Sprint start date (YYYY-MM-DD), default: next Monday
  --sprint-duration <n> Sprint duration in days, default: 14
  --sprint-count <n>    Number of sprints to create, default: 7
  --dry-run             Show what would be created without making changes
  -h, --help            Show this help message

EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --org)           ORG="$2"; shift 2 ;;
        --repo)          REPO="$2"; shift 2 ;;
        --title)         PROJECT_TITLE="$2"; shift 2 ;;
        --prefix)        MILESTONE_PREFIX="$2"; shift 2 ;;
        --description)   PROJECT_DESCRIPTION="$2"; shift 2 ;;
        --readme)        README_FILE="$2"; shift 2 ;;
        --sprint-start)  SPRINT_START_DATE="$2"; shift 2 ;;
        --sprint-duration) SPRINT_DURATION="$2"; shift 2 ;;
        --sprint-count)  SPRINT_COUNT="$2"; shift 2 ;;
        --dry-run)       DRY_RUN=true; shift ;;
        -h|--help)       usage ;;
        *) echo "Unknown option: $1"; usage ;;
    esac
done

# Validate required args
if [[ -z "$ORG" || -z "$REPO" || -z "$PROJECT_TITLE" ]]; then
    echo "Error: --org, --repo, and --title are required"
    usage
fi

FULL_REPO="${ORG}/${REPO}"

# --- Helper functions --------------------------------------------------------

log()  { echo "[INFO]  $*"; }
warn() { echo "[WARN]  $*" >&2; }
err()  { echo "[ERROR] $*" >&2; exit 1; }

check_prerequisites() {
    command -v gh >/dev/null 2>&1 || err "gh CLI not found. Install: https://cli.github.com/"
    gh auth status >/dev/null 2>&1 || err "Not authenticated. Run: gh auth login"

    local scopes
    scopes=$(gh auth status 2>&1 | grep "Token scopes" || true)
    if ! echo "$scopes" | grep -q "project"; then
        err "Missing 'project' scope. Run: gh auth refresh -s project -s read:project"
    fi
    log "Prerequisites OK"
}

# --- Step 1: Create Project --------------------------------------------------

create_project() {
    log "Creating project: ${PROJECT_TITLE}"
    if [[ "$DRY_RUN" == true ]]; then
        log "[DRY RUN] Would create project '${PROJECT_TITLE}' in ${ORG}"
        echo "DRY_RUN_PROJECT_42"
        return
    fi

    local result
    result=$(gh project create --owner "$ORG" --title "$PROJECT_TITLE" --format json 2>&1)
    PROJECT_NUMBER=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['number'])")
    PROJECT_ID=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    log "Created project #${PROJECT_NUMBER} (${PROJECT_ID})"

    # Set description
    if [[ -n "$PROJECT_DESCRIPTION" ]]; then
        gh project edit "$PROJECT_NUMBER" --owner "$ORG" --description "$PROJECT_DESCRIPTION"
        log "Set project description"
    fi

    # Set README
    if [[ -n "$README_FILE" && -f "$README_FILE" ]]; then
        gh project edit "$PROJECT_NUMBER" --owner "$ORG" --readme "$(cat "$README_FILE")"
        log "Set project README from ${README_FILE}"
    fi

    # Link to repo
    gh project link "$PROJECT_NUMBER" --owner "$ORG" --repo "$FULL_REPO"
    log "Linked project to ${FULL_REPO}"

    echo "$PROJECT_NUMBER"
}

# --- Step 2: Configure Status (Board Columns) --------------------------------

configure_status_field() {
    local project_number="$1"
    log "Configuring board columns (Status field)"

    if [[ "$DRY_RUN" == true ]]; then
        log "[DRY RUN] Would set Status options: Backlog, This Week, In Progress, In Review, Done, Blocked"
        return
    fi

    # Get Status field ID
    local status_field_id
    status_field_id=$(gh project field-list "$project_number" --owner "$ORG" --format json | \
        python3 -c "import json,sys; fields=json.load(sys.stdin)['fields']; print(next(f['id'] for f in fields if f['name']=='Status'))")

    gh api graphql -f query="
    mutation {
      updateProjectV2Field(input: {
        fieldId: \"${status_field_id}\"
        singleSelectOptions: [
          {name: \"📋 Backlog\", color: GRAY, description: \"Not yet scheduled\"}
          {name: \"📅 This Week\", color: BLUE, description: \"Planned for this week\"}
          {name: \"🚧 In Progress\", color: YELLOW, description: \"Currently being worked on\"}
          {name: \"👀 In Review\", color: ORANGE, description: \"Waiting for code review\"}
          {name: \"✅ Done\", color: GREEN, description: \"Completed\"}
          {name: \"❌ Blocked\", color: RED, description: \"Blocked by dependency or issue\"}
        ]
      }) {
        projectV2Field { ... on ProjectV2SingleSelectField { name options { name } } }
      }
    }" >/dev/null

    log "Status field configured with 6 columns"
}

# --- Step 3: Create Custom Fields --------------------------------------------

create_custom_fields() {
    local project_number="$1"
    log "Creating custom fields"

    if [[ "$DRY_RUN" == true ]]; then
        log "[DRY RUN] Would create: Priority (single select), Component (single select), Week (number), Sprint (iteration)"
        return
    fi

    # Get project ID for GraphQL
    local project_id
    project_id=$(gh project view "$project_number" --owner "$ORG" --format json | \
        python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

    # Priority
    gh project field-create "$project_number" --owner "$ORG" \
        --name "Priority" --data-type "SINGLE_SELECT" \
        --single-select-options "P0-critical,P1-high,P2-medium,P3-low"
    log "  Created: Priority"

    # Component
    gh project field-create "$project_number" --owner "$ORG" \
        --name "Component" --data-type "SINGLE_SELECT" \
        --single-select-options "backend,frontend,rag,devops,design,testing,docs,setup"
    log "  Created: Component"

    # Week
    gh project field-create "$project_number" --owner "$ORG" \
        --name "Week" --data-type "NUMBER"
    log "  Created: Week"

    # Sprint (iteration) - requires GraphQL
    local start_date="${SPRINT_START_DATE}"
    if [[ -z "$start_date" ]]; then
        # Default to next Monday
        start_date=$(date -d "next Monday" +%Y-%m-%d 2>/dev/null || date -v+1w -v-Mon +%Y-%m-%d 2>/dev/null || echo "2026-05-26")
    fi

    # Build iteration list
    local iterations=""
    for i in $(seq 0 $((SPRINT_COUNT - 1))); do
        local iter_start
        iter_start=$(date -d "${start_date} + $((i * SPRINT_DURATION)) days" +%Y-%m-%d 2>/dev/null || \
                     python3 -c "from datetime import datetime,timedelta; print((datetime.strptime('${start_date}','%Y-%m-%d')+timedelta(days=$((i * SPRINT_DURATION)))).strftime('%Y-%m-%d'))")
        local sprint_num=$((i + 1))
        if [[ -n "$iterations" ]]; then iterations="${iterations} "; fi
        iterations="${iterations}{startDate: \"${iter_start}\", duration: ${SPRINT_DURATION}, title: \"Sprint ${sprint_num}\"}"
    done

    gh api graphql -f query="
    mutation {
      createProjectV2Field(input: {
        projectId: \"${project_id}\"
        dataType: ITERATION
        name: \"Sprint\"
        iterationConfiguration: {
          startDate: \"${start_date}\"
          duration: ${SPRINT_DURATION}
          iterations: [${iterations}]
        }
      }) {
        projectV2Field { ... on ProjectV2IterationField { name id } }
      }
    }" >/dev/null

    log "  Created: Sprint (${SPRINT_COUNT} iterations, ${SPRINT_DURATION}-day duration, starting ${start_date})"
}

# --- Step 4: Create Labels ---------------------------------------------------

create_labels() {
    log "Creating labels on ${FULL_REPO}"

    # Label definitions: name|color|description
    local labels=(
        "gsoc-2026|1C6E0E|GSoC 2026 project - all issues for this project carry this label"
        "epic|6E49CB|Parent feature issue with sub-issues"
        "type:feature|0E8A16|New functionality"
        "type:bug|D73A4A|Something isn't working"
        "type:docs|0075CA|Documentation improvements"
        "type:refactor|CFD3D7|Code cleanup or restructuring"
        "type:test|BFD4F2|Testing additions"
        "P0-critical|B60205|Blocking progress, must do"
        "P1-high|D93F0B|Important for milestone"
        "P2-medium|FBCA04|Should do"
        "P3-low|0E8A16|Nice to have"
        "backend|5319E7|Go API layer"
        "frontend|1D76DB|React/Vue web UI"
        "rag|F9D0C4|AI/RAG engine and query processing"
        "devops|006B75|CI/CD, Docker, deployment"
        "design|D4C5F9|Architecture and API design"
        "testing|BFD4F2|Test coverage and quality"
        "docs|0075CA|Documentation"
        "setup|C2E0C6|Environment setup and onboarding"
        "learning|FEF2C0|Codebase exploration and research"
    )

    local created=0
    local skipped=0

    for entry in "${labels[@]}"; do
        IFS='|' read -r name color desc <<< "$entry"
        if [[ "$DRY_RUN" == true ]]; then
            log "[DRY RUN] Would create label: ${name} (#${color})"
            continue
        fi

        if gh label create "$name" --repo "$FULL_REPO" --color "$color" --description "$desc" 2>/dev/null; then
            created=$((created + 1))
        else
            # Try to update if it already exists
            if gh label edit "$name" --repo "$FULL_REPO" --color "$color" --description "$desc" 2>/dev/null; then
                skipped=$((skipped + 1))
            else
                warn "Failed to create/update label: ${name}"
            fi
        fi
    done

    log "Labels: ${created} created, ${skipped} updated"
}

# --- Step 5: Create Milestones -----------------------------------------------

create_milestones() {
    log "Creating milestones on ${FULL_REPO}"

    # Milestone definitions: title|due_date|description
    local milestones=(
        "Week 1 - Ramp-Up|2026-05-31|Environment setup, codebase understanding"
        "Week 2 - API Design|2026-06-07|REST API spec finalized, frontend scaffolded"
        "Week 3 - API Implementation|2026-06-14|Core API endpoints working, RAG accessible via HTTP"
        "Week 4 - Chat UI|2026-06-21|Browser chat sends queries and displays generated templates"
        "Week 5 - Streaming & Demo Prep|2026-06-28|Streaming responses, demo-ready"
        "★ Demo 1|2026-07-01|End-to-end: query -> RAG -> generated template in browser"
        "Week 6 - Sessions & Conversations|2026-07-05|Multi-turn conversations work in web UI"
        "Week 7 - Template Editor|2026-07-12|Visual YAML editor with real-time validation"
        "Week 8 - Template Library|2026-07-19|Browse, search, and filter existing templates"
        "Week 9 - Query Quality|2026-07-26|Full query classification and hybrid scoring per ADR"
        "Week 10 - Build Dashboard|2026-08-02|Trigger and monitor image builds from web UI"
        "Week 11 - Agentic Validation|2026-08-09|Auto-validation and self-correction loop"
        "Week 12 - Testing & Docs|2026-08-16|Test coverage, documentation, security review"
        "Week 13 - Final Polish|2026-08-23|Bug fixes, deployment packaging, demo prep"
        "★ Demo 2|2026-08-19|Full working web application"
    )

    local created=0
    for entry in "${milestones[@]}"; do
        IFS='|' read -r title due_date desc <<< "$entry"

        # Apply prefix if set
        if [[ -n "$MILESTONE_PREFIX" ]]; then
            title="${MILESTONE_PREFIX}: ${title}"
        fi

        if [[ "$DRY_RUN" == true ]]; then
            log "[DRY RUN] Would create milestone: ${title} (due: ${due_date})"
            continue
        fi

        gh api "repos/${FULL_REPO}/milestones" \
            -f title="$title" \
            -f due_on="${due_date}T23:59:59Z" \
            -f description="$desc" --silent 2>/dev/null && created=$((created + 1)) || \
            warn "Failed to create milestone: ${title}"
    done

    log "Milestones: ${created} created"
}

# --- Main --------------------------------------------------------------------

main() {
    echo "============================================="
    echo "  GitHub Project Setup"
    echo "============================================="
    echo "  Org:    ${ORG}"
    echo "  Repo:   ${REPO}"
    echo "  Title:  ${PROJECT_TITLE}"
    echo "  Prefix: ${MILESTONE_PREFIX:-<none>}"
    echo "============================================="
    echo ""

    check_prerequisites

    # Step 1: Create project
    local project_number
    project_number=$(create_project)
    echo ""

    # Step 2: Configure board columns
    configure_status_field "$project_number"
    echo ""

    # Step 3: Create custom fields
    create_custom_fields "$project_number"
    echo ""

    # Step 4: Create labels
    create_labels
    echo ""

    # Step 5: Create milestones
    create_milestones
    echo ""

    echo "============================================="
    echo "  Setup Complete!"
    echo "============================================="
    echo "  Project: https://github.com/orgs/${ORG}/projects/${project_number}"
    echo "  Repo:    https://github.com/${FULL_REPO}"
    echo "  Labels:  https://github.com/${FULL_REPO}/labels"
    echo "  Miles:   https://github.com/${FULL_REPO}/milestones"
    echo ""
    echo "  Manual steps remaining:"
    echo "    1. Rename views (Table, Board) in project UI"
    echo "    2. Add Roadmap view if desired"
    echo "    3. Enable Hierarchy View: View menu -> Show hierarchy"
    echo "    4. Drag Board tab to first position"
    echo "============================================="
}

main
