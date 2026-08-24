export const translations: Readonly<Record<string, string>> = {
  "platformClaw.organization.title": "Organization",
  "platformClaw.organization.navLabel": "Organization",
  "platformClaw.organization.subtitle":
    "View your place in the organization and manage delegated scopes.",
  "platformClaw.organization.loading": "Loading organization…",
  "platformClaw.organization.saved": "Organization updated.",
  "platformClaw.organization.savedReloadFailed":
    "Organization updated, but the latest state could not be reloaded. Reload this page before another change.",
  "platformClaw.organization.search": "Search",
  "platformClaw.organization.tabs.label": "Organization sections",
  "platformClaw.organization.tabs.overview": "Overview",
  "platformClaw.organization.tabs.management": "Management",
  "platformClaw.organization.kind.team": "Team",
  "platformClaw.organization.kind.group": "Group",
  "platformClaw.organization.kind.part": "Part",
  "platformClaw.organization.role.member": "Member",
  "platformClaw.organization.role.leader": "Leader",
  "platformClaw.organization.my.title": "My organization",
  "platformClaw.organization.my.description":
    "Your direct memberships, inherited access, and primary scope.",
  "platformClaw.organization.my.unaffiliated": "No organization membership",
  "platformClaw.organization.my.unaffiliatedDescription":
    "You can continue using PlatformClaw without joining a scope.",
  "platformClaw.organization.my.primary": "Primary scope",
  "platformClaw.organization.my.primaryDescription": "Used as your default organization context.",
  "platformClaw.organization.my.primaryCurrent": "Current primary scope",
  "platformClaw.organization.my.noPrimary": "No primary scope",
  "platformClaw.organization.my.effective": "Effective access",
  "platformClaw.organization.my.noEffective": "No organization scope access",
  "platformClaw.organization.my.truncated":
    "More memberships or effective scopes exist than can be shown here.",
  "platformClaw.organization.access.direct": "direct",
  "platformClaw.organization.access.ancestor": "inherited",
  "platformClaw.organization.access.administrator": "administrator",
  "platformClaw.organization.tree.title": "Organization tree",
  "platformClaw.organization.tree.description":
    "Active Team, Group, and Part scopes are shown with their full lineage.",
  "platformClaw.organization.tree.empty": "No active scopes",
  "platformClaw.organization.tree.emptyDescription":
    "An administrator has not created an organization structure yet.",
  "platformClaw.organization.tree.truncated": "More scopes exist. Use search to narrow the tree.",
  "platformClaw.organization.tree.search": "Search active scopes",
  "platformClaw.organization.management.title": "Organization management",
  "platformClaw.organization.management.description": "Manage only the scopes delegated to you.",
  "platformClaw.organization.management.none": "No managed scopes",
  "platformClaw.organization.management.noneDescription":
    "No manageable scope is shown in these results. Search by scope name.",
  "platformClaw.organization.management.scope": "Managed scope",
  "platformClaw.organization.management.scopeDescription":
    "Lineage labels distinguish scopes with the same name.",
  "platformClaw.organization.management.search": "Search manageable scopes",
  "platformClaw.organization.management.searchHasMore":
    "More manageable scopes match. Refine the search.",
  "platformClaw.organization.members.empty": "No members",
  "platformClaw.organization.members.emptyDescription": "This scope has no direct members.",
  "platformClaw.organization.members.role": "Membership role",
  "platformClaw.organization.members.remove": "Remove",
  "platformClaw.organization.members.add": "Add a member",
  "platformClaw.organization.members.addDescription":
    "Search active users by account or display name.",
  "platformClaw.organization.members.search": "At least 2 characters",
  "platformClaw.organization.members.addAction": "Add",
  "platformClaw.organization.members.more": "Load more members",
  "platformClaw.organization.members.searchHasMore":
    "More users match. Refine the search to find the right account.",
  "platformClaw.organization.structure.create": "Create a scope",
  "platformClaw.organization.structure.createDescription":
    "Administrators can create Team, Group, and Part scopes.",
  "platformClaw.organization.structure.name": "Scope name",
  "platformClaw.organization.structure.parent": "Parent scope",
  "platformClaw.organization.structure.chooseParent": "Choose a parent",
  "platformClaw.organization.structure.create.team": "Create Team",
  "platformClaw.organization.structure.create.group": "Create Group",
  "platformClaw.organization.structure.create.part": "Create Part",
  "platformClaw.organization.structure.createAction": "Create",
  "platformClaw.organization.structure.selected": "Selected scope",
  "platformClaw.organization.structure.rename": "Rename",
  "platformClaw.organization.structure.archive": "Archive",
  "platformClaw.organization.action.add": "Confirm member addition",
  "platformClaw.organization.action.remove": "Confirm member removal",
  "platformClaw.organization.action.role": "Confirm role change",
  "platformClaw.organization.action.rename": "Confirm scope rename",
  "platformClaw.organization.action.archive": "Confirm scope archive",
  "platformClaw.organization.action.archiveWarning":
    "Archiving also makes every descendant inactive, rejects pending joins and promotions, retires active Memory claims, and clears affected primary scopes. Skill Hub bindings must be transferred or retired first.",
  "platformClaw.organization.action.reason": "Reason",
  "platformClaw.organization.action.confirm": "Confirm",
  "platformClaw.organization.action.cancel": "Cancel",
  "platformClaw.organization.errors.unavailable":
    "Organization service is unavailable. Refresh and try again.",
  "platformClaw.organization.errors.forbidden":
    "You no longer have permission for this organization action.",
  "platformClaw.organization.errors.notFound":
    "The organization item no longer exists or is not visible to you.",
  "platformClaw.organization.errors.conflict": "The organization changed. Refresh and try again.",
  "platformClaw.organization.errors.membershipChanged":
    "The roster changed. Review the current role, then try again.",
  "platformClaw.organization.errors.nameConflict":
    "That name already exists under the selected parent. Choose another name.",
  "platformClaw.organization.errors.invalid": "Check the organization fields and try again.",
  "platformClaw.organization.errors.archiveBlocked":
    "Archive is blocked. Transfer or retire affected Skill Hub namespace bindings, then try again.",
  "platformClaw.organization.errors.searchLength": "Enter at least 2 characters to search users.",
  "platformClaw.organization.errors.noMembershipRemoved":
    "No membership was removed. The roster was refreshed; review its current state.",
  "platformClaw.memory.tabs.label": "Memory and knowledge sections",
  "platformClaw.memory.tabs.overview": "Overview",
  "platformClaw.memory.tabs.organization": "Organization",
  "platformClaw.memory.overview.title": "Memory and knowledge",
  "platformClaw.memory.overview.description":
    "Memory recalls personal context, Personal Wiki keeps reusable documents, and Dreaming organizes durable knowledge.",
  "platformClaw.memory.overview.memoryDescription":
    "Search MEMORY.md, daily memory, and other indexed personal context.",
  "platformClaw.memory.overview.wikiDescription":
    "Browse structured pages that can be reviewed and shared with your organization.",
  "platformClaw.memory.overview.dreamingDescription":
    "Review consolidation status, Dream Diary, and memory activity.",
  "platformClaw.memory.overview.openMemory": "Open Memory",
  "platformClaw.memory.overview.openWiki": "Open Personal Wiki",
  "platformClaw.memory.overview.openDreaming": "Open Dreaming",
  "memoryPage.promotions.loading": "Loading organization knowledge…",
  "memoryPage.promotions.target": "Target scope",
  "memoryPage.promotions.scope": "Organization scope",
  "memoryPage.promotions.team": "Team",
  "memoryPage.promotions.publishDirect": "Publish directly as administrator",
  "memoryPage.promotions.personalSourceTitle": "Choose a personal Wiki source",
  "memoryPage.promotions.personalSourceHelp":
    "Search your personal Wiki, preview a complete page, then edit the proposed shared claim before submitting.",
  "memoryPage.promotions.searchPersonalWiki": "Search personal Wiki pages",
  "memoryPage.promotions.search": "Search",
  "memoryPage.promotions.sourceLoading": "Loading personal Wiki sources…",
  "memoryPage.promotions.sourceEmpty": "No personal Wiki pages matched this search.",
  "memoryPage.promotions.sourceIncomplete": "This Wiki page is incomplete and cannot be promoted.",
  "memoryPage.promotions.sourcePreview": "Source preview",
  "memoryPage.promotions.personalWikiEvidence": "Personal Wiki source",
  "memoryPage.promotions.approvedClaimEvidence": "Approved organization claim",
  "memoryPage.promotions.defaultReason": "Share this reviewed knowledge with the organization.",
  "memoryPage.promotions.proposedText": "Shared knowledge",
  "memoryPage.promotions.revision": "revision {revision}",
  "memoryPage.promotions.statusPending": "Pending",
  "memoryPage.promotions.statusApproved": "Approved",
  "memoryPage.promotions.statusRejected": "Rejected",
  "memoryPage.promotions.statusActive": "Active",
  "memoryPage.promotions.statusRetired": "Retired",
  "memoryPage.promotions.statusPurged": "Purged",
  "memoryPage.promotions.noReviews": "No promotion requests need your review.",
  "memoryPage.promotions.noRequests": "You have not submitted any promotion requests.",
  "memoryPage.promotions.noClaims":
    "No organization claims are available in your authorized scopes.",
  "platformClaw.guide.neverShowAgain": "Don't show again",
  "platformClaw.guide.progress": "{current} of {total}",
  "platformClaw.guide.next": "Next",
  "platformClaw.guide.previous": "Previous",
  "platformClaw.guide.done": "Done",
  "platformClaw.guide.unavailable": "The guide could not be opened. Refresh and try again.",
  "platformClaw.guide.welcomeTitle": "Welcome to PlatformClaw",
  "platformClaw.guide.welcomeBody": "Take a quick tour of the tools you will use most often.",
  "platformClaw.guide.chatTitle": "Home: start a conversation with your Agent",
  "platformClaw.guide.chatBody": "Start a new request and work with your Agent from here.",
  "platformClaw.guide.chatDetails":
    "A conversation keeps the context established by earlier messages.|Use a new conversation for unrelated work so results and history stay easy to find.",
  "platformClaw.guide.usageTitle": "Usage: understand tokens and cost",
  "platformClaw.guide.usageBody":
    "Review the tokens your Agents used and their estimated cost over a selected period.",
  "platformClaw.guide.usageDetails":
    "Change the date range to review input tokens, output tokens, and cost trends.|Break usage down by Agent, model, and conversation to find expensive work.|Use detail and cache metrics to spot repeated work that can be optimized.",
  "platformClaw.guide.tasksTitle": "Tasks: follow assigned work",
  "platformClaw.guide.tasksBody": "See whether work assigned to an Agent is active or complete.",
  "platformClaw.guide.tasksDetails":
    "Separate active work from completed results.|Open a task to review its goal and current status, then continue with any follow-up request.",
  "platformClaw.guide.sessionsTitle": "Threads: continue an earlier conversation",
  "platformClaw.guide.sessionsBody":
    "Find previous conversations and resume work with their context.",
  "platformClaw.guide.sessionsDetails":
    "Use titles and recent activity to find the conversation you need.|Archive finished conversations and reopen them later without losing their context.",
  "platformClaw.guide.activityTitle": "Activity: inspect what the Agent did",
  "platformClaw.guide.activityBody":
    "Review tools the Agent ran and their outcomes as they happen.",
  "platformClaw.guide.activityDetails":
    "Filter by running, done, or error status and by tool name.|Expand an item to inspect its run ID, related conversation, and output preview when troubleshooting.",
  "platformClaw.guide.automationsTitle": "Automations: schedule recurring work",
  "platformClaw.guide.automationsBody":
    "Manage Agent work that runs at a particular time or on a recurring schedule.",
  "platformClaw.guide.automationsDetails":
    "Set the schedule, responsible Agent, and work to perform.|Review the next run and recent success or failure, or run it immediately.|Open run history to inspect results and delivery status.",
  "platformClaw.guide.pluginsNavTitle": "Plugins: extend Agent capabilities",
  "platformClaw.guide.pluginsNavBody":
    "Open the hub for service connections, reusable instructions, and company skills.",
  "platformClaw.guide.pluginsNavDetails":
    "Plugins connect the Agent to external services and tools.|Skills give the Agent a reusable way to perform work.|Select Next to enter the Plugins screen and learn each tab in order.",
  "platformClaw.guide.workLocationTitle": "Choose where work runs",
  "platformClaw.guide.workLocationBody":
    "Switch between the Basic workspace and your assigned development VM.",
  "platformClaw.guide.clickTarget": "LOOK HERE",
  "platformClaw.guide.pluginsTitle": "Understand the Plugins hub",
  "platformClaw.guide.pluginsBody":
    "This screen groups every way you can extend what your Agent can do.",
  "platformClaw.guide.pluginsDetails":
    "Installed manages active plugins and service connections.|Discover finds new plugins and one-click connectors.|Skills contains reusable instructions the Agent follows.|Workshop reviews proposed skill changes before they go live.|Skill Hub is the company catalog for sharing and installing skills.",
  "platformClaw.guide.installedPluginsTitle": "Installed: manage active plugins",
  "platformClaw.guide.installedPluginsBody":
    "A plugin connects the Agent to a service, tool, channel, or model provider.",
  "platformClaw.guide.installedPluginsDetails":
    "Search or filter by Enabled, Disabled, and Issues.|Open Details to check purpose, source, version, and setup requirements.|Enable or disable a plugin here; restart when the screen says it is required.",
  "platformClaw.guide.discoverPluginsTitle": "Discover: add new capabilities",
  "platformClaw.guide.discoverPluginsBody":
    "Browse featured and official plugins, MCP connectors, and ClawHub results.",
  "platformClaw.guide.discoverPluginsDetails":
    "Featured and Official are curated plugin choices.|Connect your world adds common MCP services with fewer setup steps.|ClawHub expands the search to community plugins; review trust and permissions before installing.",
  "platformClaw.guide.skillsTitle": "Skills: instructions your Agent can reuse",
  "platformClaw.guide.skillsBody":
    "A skill is a task playbook, not a service connection. It teaches the Agent how to do repeatable work.",
  "platformClaw.guide.skillsDetails":
    "Ready can be used now; Needs Setup shows missing requirements; Disabled is inactive.|Open a skill to read its instructions and required tools.|Publish your own skill version to Skill Hub when it is ready to share.",
  "platformClaw.guide.workshopTitle": "Workshop: review skill changes safely",
  "platformClaw.guide.workshopBody":
    "Draft skill changes stay separate from live skills until you approve them.",
  "platformClaw.guide.workshopDetails":
    "Ask the Agent in chat to create or improve a skill.|Evaluate runs checks; Request revision sends it back for changes.|Confirm the work location, then Apply to make the reviewed version live.",
  "platformClaw.guide.skillHubTitle": "Skill Hub: install and share company skills",
  "platformClaw.guide.skillHubBody":
    "Search the company catalog for a skill that already solves your task.",
  "platformClaw.guide.skillHubDetails":
    "Search by task, then open a result to review its description and versions.|Choose a version and select Install.|Pick Basic Workspace or My VM Workspace as the installation target.",
  "platformClaw.guide.reopenTitle": "Open this guide anytime",
  "platformClaw.guide.reopenBody":
    "Use the Guide button whenever you want to review these features.",
};
