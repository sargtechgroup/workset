const STORAGE_KEY = "fieldwork-data-v2";
const LEGACY_STORAGE_KEY = "fieldwork-demo-v1";
const CREW_ROLE_OPTIONS = [
  "Foreman",
  "Crew Lead",
  "ILI Operator",
  "Cleaning Operator",
  "Gauging Operator",
  "Equipment Operator",
  "Field Technician",
  "Safety Coordinator",
  "Supervisor",
  "Other",
];
const today = new Date();
const dateOffset = (offset) => {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const datesBetween = (start, end) => {
  const dates = [];
  const cursor = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  while (cursor <= last) {
    dates.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
};
const uid = () => `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const uuid = () => crypto.randomUUID
  ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.random() * 16 | 0;
    return (char === "x" ? random : (random & 0x3 | 0x8)).toString(16);
  });
const initialState = () => ({
  user: "",
  jobs: [],
  clients: [],
  tasks: [],
  people: [],
  equipment: [],
  contractors: [],
  contractorSubmissions: [],
  invoices: [],
  safety: [],
  safetyLibrary: [],
  safetyLibraryFolders: [],
  safetyTemplates: [],
  reports: [],
  runs: [],
  timesheets: [],
});

const seededDemoIds = {
  jobs: new Set(["j1", "j2", "j3"]),
  tasks: new Set(["t1", "t2", "t3", "t4"]),
  people: new Set(["p1", "p2", "p3", "p4"]),
  equipment: new Set(["e1", "e2", "e3", "e4"]),
  contractors: new Set(["c1", "c2"]),
  invoices: new Set(["i1", "i2"]),
  safety: new Set(["s1", "s2", "s3", "s4"]),
  runs: new Set(["r1", "r2", "r3"]),
};

function stripSeededDemoRecords(data) {
  const cleaned = { ...(data || {}) };
  let removed = 0;
  for (const [collection, ids] of Object.entries(seededDemoIds)) {
    if (!Array.isArray(cleaned[collection])) continue;
    const records = cleaned[collection];
    cleaned[collection] = records.filter((record) => !ids.has(record?.id));
    removed += records.length - cleaned[collection].length;
  }
  return { data: cleaned, removed };
}

function loadState() {
  try {
    const currentSaved = localStorage.getItem(STORAGE_KEY);
    const legacySaved = localStorage.getItem(LEGACY_STORAGE_KEY);
    const saved = currentSaved || legacySaved;
    if (!saved) return initialState();
    const cleaned = stripSeededDemoRecords(JSON.parse(saved));
    const restored = restoreState(cleaned.data);
    if (cleaned.removed || !currentSaved) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(restored));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    return restored;
  } catch (error) {
    console.error("Could not load saved Fieldwork data.", error);
    return initialState();
  }
}

function restoreState(parsed) {
    const defaults = initialState();
    const restored = { ...defaults, ...parsed, user: parsed.user || "" };
    delete restored.trackingTools;
    if (!Array.isArray(restored.safetyLibrary)) restored.safetyLibrary = [];
    if (!Array.isArray(restored.safetyLibraryFolders)) restored.safetyLibraryFolders = [];
    const savedClients = Array.isArray(parsed.clients) ? parsed.clients : [];
    const clientsByName = new Map(savedClients
      .filter((client) => typeof client?.name === "string" && client.name.trim())
      .map((client) => [client.name.trim().toLowerCase(), {
        ...client,
        id: client.id || uid(),
        name: client.name.trim(),
      }]));
    restored.jobs.forEach((job) => {
      const name = String(job.client || "").trim();
      const key = name.toLowerCase();
      if (name && !clientsByName.has(key)) clientsByName.set(key, { id: uid(), name });
      if (name) job.clientId = clientsByName.get(key).id;
    });
    restored.clients = [...clientsByName.values()];
    if (!Array.isArray(parsed.contractors)) {
      const names = [...new Set(restored.invoices.map((invoice) => invoice.contractor).filter(Boolean))];
      restored.contractors = names.map((name, index) => ({ id: `c${index + 1}`, name }));
    }
    restored.invoices = restored.invoices.map((invoice) => {
      if (invoice.contractorId) return invoice;
      const contractor = restored.contractors.find((company) => company.name === invoice.contractor);
      return contractor ? { ...invoice, contractorId: contractor.id } : invoice;
    });
    restored.contractors = restored.contractors.map((contractor) => ({
      ...contractor,
      pricing: {
        laborRates: contractor.pricing?.laborRates || {},
        equipmentRates: contractor.pricing?.equipmentRates || {},
      },
    }));
    return restored;
}

let state = loadState();
let supabaseClient = null;
let authSession = null;
let userProfile = null;
let workspaceVersion = 0;
let workspaceDirty = false;
let workspaceWriteInProgress = false;
let workspaceRevision = 0;
let workspaceSyncTimer;
let workspaceChannel = null;
let profilesCache = [];
let contractorCompaniesCache = [];
let contractorCrewMembersCache = [];
let adminProfilesRequest = 0;
let foremanProfilesCache = [];
let contractorAccessChannel = null;
let contractorAccessRefreshTimer;
let contractorCompany = null;
let contractorWorkflow = { jobs: [], rateCard: null, equipment: [], jobEquipment: [], invoices: [] };
let adminContractorRates = [];
let adminContractorEquipment = [];
let adminContractorAssignments = [];
let adminContractorJobEquipment = [];
let adminContractorInvoices = [];
let safetyTickets = [];
let authMode = "signin";
let activePage = "overview";
let gpsCalculatorMode = "distance";
let gpsCalculatorAutoAdd = true;
let gpsWorkspaceJobId = "";
let gpsWorkspaceUnmount = null;
let foremanJobId = "";
let safetyFormDraft = null;
let safetyLibraryFolderId = "";
let personalWorkspaceData = { userId: "", workspaces: [], modules: [], selectedId: "", editModuleId: "", loaded: false, error: "" };
let personalWorkspaceRequest = 0;
let signaturePad = null;
let printingSafetyRecordId = "";
let calendarDate = new Date(today.getFullYear(), today.getMonth(), 1);
let jobScheduleView = "calendar";
let analyticsFilters = { start: "", end: "", jobId: "", contractorId: "" };
let toastTimer;
let logoutInProgress = false;
let assistantMessages = [];
const assistantTaskDrafts = new Map();
const pageContent = document.getElementById("page-content");
const modal = document.getElementById("modal");
const modalContent = document.getElementById("modal-content");
const assistantPanel = document.getElementById("assistant-panel");

const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const initials = (name = "?") => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
const ALBERTA_GST_RATE = 0.05;
const money = (amount) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 2 }).format(Number(amount) || 0);
const roundCurrency = (amount) => Math.round(((Number(amount) || 0) + Number.EPSILON) * 100) / 100;
const gstFor = (subtotal) => roundCurrency(roundCurrency(subtotal) * ALBERTA_GST_RATE);
const invoiceTotal = (subtotal) => roundCurrency(roundCurrency(subtotal) + gstFor(subtotal));

function downloadWorkbook(rows, filename, sheetName) {
  if (!rows.length) {
    showToast("There is no data to export for these filters.");
    return;
  }
  if (!window.XLSX) {
    console.error("Excel export is unavailable because the spreadsheet library did not load.");
    showToast("Excel export is unavailable. Check your connection and try again.");
    return;
  }
  const workbook = window.XLSX.utils.book_new();
  const worksheet = window.XLSX.utils.json_to_sheet(rows);
  if (worksheet["!ref"]) {
    const range = window.XLSX.utils.decode_range(worksheet["!ref"]);
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const header = worksheet[window.XLSX.utils.encode_cell({ r: range.s.r, c: column })]?.v;
      if (typeof header !== "string" || !header.endsWith("CAD")) continue;
      for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
        const cell = worksheet[window.XLSX.utils.encode_cell({ r: row, c: column })];
        if (cell && typeof cell.v === "number") cell.z = '"CAD "#,##0.00';
      }
    }
  }
  window.XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  window.XLSX.writeFile(workbook, filename);
  showToast(`${rows.length} row${rows.length === 1 ? "" : "s"} exported to Excel.`);
}

function printReport(target) {
  document.body.dataset.printTarget = target;
  window.addEventListener("afterprint", () => {
    delete document.body.dataset.printTarget;
  }, { once: true });
  window.print();
}

function contractorInvoiceExportRows(invoices, contractorLookup, jobLookup) {
  return invoices.map((invoice) => {
    const subtotal = Number(invoice.amount || 0);
    const company = contractorLookup(invoice.company_id || invoice.contractorId);
    const jobId = invoice.job_id || invoice.jobId;
    return {
      company: company?.name || "Contractor",
      invoice: invoice.invoice_number || invoice.number || "",
      job: jobLookup(jobId) || jobId || "",
      workDate: invoice.work_date || invoice.date || invoice.due || "",
      subtotalCAD: roundCurrency(subtotal),
      albertaGST5PercentCAD: gstFor(subtotal),
      totalCAD: invoiceTotal(subtotal),
      status: invoice.status || "",
    };
  });
}
const formatDate = (date, options = { month: "short", day: "numeric" }) => date ? new Date(`${date}T12:00:00`).toLocaleDateString("en-US", options) : "—";
const jobById = (id) => state.jobs.find((job) => job.id === id);
const contractorById = (id) => state.contractors.find((contractor) => contractor.id === id);
const invoiceCompany = (invoice) => contractorById(invoice.contractorId)?.name || invoice.contractor || "Unknown company";
const contractorRoles = () => [...new Set([...CREW_ROLE_OPTIONS, ...state.people.map((person) => person.role).filter(Boolean)])].sort();
const contractorEquipmentTypes = () => [...new Set(state.equipment.map((item) => item.type).filter(Boolean))].sort();
const jobNames = (ids = []) => ids.map((id) => jobById(id)?.name).filter(Boolean).join(", ") || "No job assigned";
const shortJobName = (id) => jobById(id)?.name || "Unassigned";

function persist() {
  if (userProfile?.role === "foreman") {
    setSyncStatus("readonly", "Read only · assigned jobs");
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (authSession && userProfile) {
      if (userProfile.role === "admin" || userProfile.role === "manager") {
        workspaceDirty = true;
        workspaceRevision += 1;
        setSyncStatus("pending", "Saving changes");
        clearTimeout(workspaceSyncTimer);
        workspaceSyncTimer = setTimeout(syncWorkspace, 450);
      } else {
        setSyncStatus("readonly", "Read only");
      }
    }
  } catch (error) {
    console.error("Could not save Fieldwork data.", error);
    showToast("Unable to save changes in this browser.");
  }
}

function setSyncStatus(status, message) {
  const element = document.getElementById("sync-status");
  if (!element) return;
  const action = status === "conflict"
    ? `<button type="button" data-action="sync-reload">Reload shared data</button>`
    : status === "error"
      ? `<button type="button" data-action="sync-retry">Retry</button>`
      : "";
  element.className = `sync-status sync-${status}`;
  element.innerHTML = `<i></i><span>${escapeHtml(message)}</span>${action}`;
}

function sharedWorkspaceData() {
  const data = { ...state };
  delete data.user;
  return data;
}

function storeWorkspaceData(data) {
  const cleaned = stripSeededDemoRecords(data && Object.keys(data).length ? data : initialState());
  state = restoreState(cleaned.data);
  state.user = userProfile?.full_name || authSession?.user?.email || "";
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Could not cache shared Fieldwork data.", error);
  }
  return cleaned.removed;
}

async function syncWorkspace() {
  if (!workspaceDirty || workspaceWriteInProgress || !supabaseClient || !authSession || !userProfile) return;
  if (userProfile.role !== "admin" && userProfile.role !== "manager") {
    setSyncStatus("readonly", "Read only");
    return;
  }

  workspaceWriteInProgress = true;
  const revision = workspaceRevision;
  const nextVersion = workspaceVersion + 1;
  const { data, error } = await supabaseClient
    .from("workspace_state")
    .update({
      data: sharedWorkspaceData(),
      version: nextVersion,
      updated_by: authSession.user.id,
    })
    .eq("id", "main")
    .eq("version", workspaceVersion)
    .select("version")
    .maybeSingle();
  workspaceWriteInProgress = false;

  if (error) {
    console.error("Could not sync Fieldwork data to Supabase.", error);
    setSyncStatus("error", "Sync failed");
    showToast("Changes are saved on this device but could not sync. Check your connection and retry.");
    return;
  }
  if (!data) {
    setSyncStatus("conflict", "Another user updated the workspace");
    showToast("A newer shared update was found. Reload shared data to resolve the conflict.");
    return;
  }

  workspaceVersion = data.version;
  if (workspaceRevision === revision) {
    workspaceDirty = false;
    setSyncStatus("synced", "Synced");
  } else {
    workspaceSyncTimer = setTimeout(syncWorkspace, 0);
  }
}

async function reloadSharedWorkspace() {
  if (workspaceDirty && !confirm("Discard local unsynced changes and load the latest shared data?")) return;
  const { data, error } = await supabaseClient
    .from("workspace_state")
    .select("data,version")
    .eq("id", "main")
    .single();
  if (error) {
    console.error("Could not reload shared Fieldwork data.", error);
    setSyncStatus("error", "Reload failed");
    showToast("Could not reload the shared workspace. Please try again.");
    return;
  }
  const removedDemoRecords = storeWorkspaceData(data.data);
  workspaceDirty = removedDemoRecords > 0;
  workspaceVersion = data.version;
  if (removedDemoRecords) {
    workspaceRevision += 1;
    await syncWorkspace();
  } else {
    setSyncStatus("synced", "Synced");
  }
  renderPage();
}

function workspaceIsEmpty(data) {
  return !data || Object.keys(data).length === 0;
}

function showAuthMessage(message, isError = false) {
  const element = document.getElementById("auth-message");
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  document.getElementById("signup-name-field").classList.toggle("hidden", !signup);
  document.getElementById("signup-phone-field").classList.toggle("hidden", !signup);
  document.getElementById("signup-title-field").classList.toggle("hidden", !signup);
  document.getElementById("signup-account-type-field").classList.toggle("hidden", !signup);
  document.getElementById("login-name").required = signup;
  updateSignupAccountType();
  document.getElementById("login-password").autocomplete = signup ? "new-password" : "current-password";
  document.getElementById("auth-submit").innerHTML = signup ? "Request access <span aria-hidden=\"true\">→</span>" : "Sign in <span aria-hidden=\"true\">→</span>";
  document.getElementById("auth-mode-toggle").textContent = signup ? "Already have an account? Sign in" : "Need an account? Request access";
  showAuthMessage("");
}

function updateSignupAccountType() {
  const inviteToken = new URLSearchParams(location.search).get("contractorInvite") || "";
  const accountType = document.getElementById("signup-account-type");
  if (inviteToken) accountType.value = "contractor";
  accountType.disabled = authMode === "signup" && !!inviteToken;
  const isContractor = !inviteToken && accountType.value === "contractor";
  document.getElementById("signup-invite-note").classList.toggle("hidden", !inviteToken || authMode !== "signup");
  document.getElementById("signup-company-field").classList.toggle("hidden", !isContractor || authMode !== "signup");
  document.getElementById("signup-company-gst-field").classList.toggle("hidden", !isContractor || authMode !== "signup");
  document.getElementById("signup-company-phone-field").classList.toggle("hidden", !isContractor || authMode !== "signup");
  document.getElementById("signup-company-address-field").classList.toggle("hidden", !isContractor || authMode !== "signup");
  document.getElementById("signup-company").required = isContractor && authMode === "signup";
  document.getElementById("signup-company-gst").required = isContractor && authMode === "signup";
  document.getElementById("signup-company-phone").required = isContractor && authMode === "signup";
  document.getElementById("signup-company-address").required = isContractor && authMode === "signup";
}

async function submitAuthForm(form) {
  if (!supabaseClient) {
    showAuthMessage("Supabase is not configured. Add your project URL and public anon/publishable key to supabase-config.js.", true);
    return;
  }
  const formData = new FormData(form);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const inviteToken = new URLSearchParams(location.search).get("contractorInvite") || "";
  const accountType = inviteToken ? "contractor" : String(formData.get("accountType") || "internal");
  const companyName = String(formData.get("companyName") || "").trim();
  const companyGstNumber = String(formData.get("companyGstNumber") || "").trim();
  const companyPhone = String(formData.get("companyPhone") || "").trim();
  const companyAddress = String(formData.get("companyAddress") || "").trim();
  const button = document.getElementById("auth-submit");
  button.disabled = true;
  showAuthMessage(authMode === "signup" ? "Creating your account…" : "Signing in…");

  try {
    if (authMode === "signup") {
      const name = String(formData.get("name") || "").trim();
      const phone = String(formData.get("phone") || "").trim();
      const jobTitle = String(formData.get("jobTitle") || "").trim();
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: { data: { full_name: name, phone, job_title: jobTitle, account_type: accountType, contractor_company_name: companyName, contractor_gst_number: companyGstNumber, contractor_business_phone: companyPhone, contractor_business_address: companyAddress, contractor_invite_token: inviteToken } },
      });
      if (error) throw error;
      if (data.session) {
        await startWorkspace(data.session);
      } else {
        const accessMessage = accountType === "contractor"
          ? inviteToken
            ? "Employee account created. Check your email to confirm it. A Fieldwork admin must approve your contractor account."
            : "Account created. Check your email to confirm it. An admin must activate your company and approve your individual account."
          : "Account created. Check your email to confirm it, then sign in. An admin must approve workspace access.";
        showAuthMessage(accessMessage);
      }
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await startWorkspace(data.session);
    }
  } catch (error) {
    console.error("Fieldwork authentication failed.", error);
    if (authSession && !userProfile) {
      await supabaseClient.auth.signOut();
      authSession = null;
    }
    showAuthMessage(error.message || "Authentication failed. Please try again.", true);
  } finally {
    button.disabled = false;
  }
}

async function startWorkspace(session) {
  authSession = session;
  const { data: profile, error: profileError } = await supabaseClient
    .from("profiles")
    .select("id,email,full_name,role,contractor_company_id,contractor_status,phone,job_title,employee_number,emergency_contact_name,emergency_contact_phone,profile_photo_path")
    .eq("id", session.user.id)
    .single();
  if (profileError) throw new Error(`Could not load your profile. Confirm the Supabase setup SQL is installed. ${profileError.message}`);
  if (profile.role === "contractor") {
    if (!profile.contractor_company_id) {
      await supabaseClient.auth.signOut();
      authSession = null;
      showAuthMessage("Your contractor company request is incomplete. Contact a Fieldwork administrator.", true);
      return;
    }
    const { data: company, error: companyError } = await supabaseClient
      .from("contractor_companies")
      .select("id,name,status,gst_number,business_address,business_phone,owner_user_id,wcb_letter_path,wcb_expires_on")
      .eq("id", profile.contractor_company_id)
      .single();
    if (companyError) throw new Error(`Could not check contractor activation. ${companyError.message}`);
    if (company.status === "rejected" || profile.contractor_status === "rejected") {
      await supabaseClient.auth.signOut();
      authSession = null;
      showAuthMessage("This contractor access request was declined. Contact a Fieldwork administrator if you believe this is an error.", true);
      return;
    }
    if (company.status === "suspended" || profile.contractor_status === "suspended") {
      await supabaseClient.auth.signOut();
      authSession = null;
      showAuthMessage("Contractor access is currently suspended. Contact a Fieldwork administrator.", true);
      return;
    }
    if (company.status !== "active" || profile.contractor_status !== "active") {
      await supabaseClient.auth.signOut();
      authSession = null;
      const message = company.status !== "active"
        ? `Your company, ${company.name}, is waiting for admin activation.`
        : "Your company is active. Your individual user account is waiting for admin approval.";
      showAuthMessage(message);
      return;
    }
    userProfile = profile;
    contractorCompany = company;
    await loadContractorWorkflow();
    state.user = profile.full_name || session.user.email;
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    document.getElementById("app").classList.add("contractor-only");
    document.getElementById("app").classList.remove("foreman-only");
    document.getElementById("page-title").textContent = "Contractor portal";
    document.getElementById("user-name").textContent = state.user;
    document.getElementById("user-role").textContent = company.name;
    document.getElementById("user-avatar").textContent = initials(state.user);
    document.getElementById("top-avatar").textContent = initials(state.user);
    document.getElementById("today-label").textContent = today.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    document.getElementById("sync-status").classList.add("hidden");
    renderPage();
    await loadSafetyTickets();
    handleSafetyTicketLink();
    return;
  }
  if (profile.role === "pending") {
    await supabaseClient.auth.signOut();
    authSession = null;
    showAuthMessage("Your account is awaiting admin approval.", true);
    return;
  }
  if (profile.role === "foreman") {
    userProfile = profile;
    activePage = "foreman";
    if (!await refreshForemanWorkspace()) {
      throw new Error("Could not load assigned jobs. Apply the foreman dashboard SQL migration.");
    }
    state.user = profile.full_name || session.user.email;
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden", "contractor-only");
    document.getElementById("user-name").textContent = state.user;
    document.getElementById("user-role").textContent = "Foreman";
    document.getElementById("page-title").textContent = "Foreman dashboard";
    document.getElementById("user-avatar").textContent = initials(state.user);
    document.getElementById("top-avatar").textContent = initials(state.user);
    document.getElementById("today-label").textContent = today.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    document.getElementById("sync-status").classList.remove("hidden");
    setSyncStatus("readonly", "Read only · assigned jobs");
    applyRoleNavigation(profile.role);
    document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item.dataset.page === "foreman"));
    renderPage();
    return;
  }
  if (profile.role !== "admin" && profile.role !== "manager") {
    throw new Error("Your account does not have an active workspace role.");
  }

  userProfile = profile;
  const { data: workspace, error: workspaceError } = await supabaseClient
    .from("workspace_state")
    .select("data,version")
    .eq("id", "main")
    .single();
  if (workspaceError) throw new Error(`Could not load shared workspace data. Confirm the Supabase setup SQL is installed. ${workspaceError.message}`);

  workspaceVersion = workspace.version;
  if (workspaceIsEmpty(workspace.data) && profile.role === "admin") {
    state = initialState();
    state.user = profile.full_name || session.user.email;
    workspaceDirty = true;
    workspaceRevision += 1;
    await syncWorkspace();
  } else {
    const removedDemoRecords = storeWorkspaceData(workspace.data);
    workspaceDirty = removedDemoRecords > 0;
    if (removedDemoRecords) {
      workspaceRevision += 1;
      await syncWorkspace();
    }
  }

  state.user = profile.full_name || session.user.email;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Could not cache Fieldwork user data.", error);
  }
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("app").classList.remove("contractor-only");
  document.getElementById("app").classList.remove("foreman-only");
  document.getElementById("sync-status").classList.remove("hidden");
  document.getElementById("user-name").textContent = state.user;
  document.getElementById("user-role").textContent = profile.role === "admin" ? "Administrator" : "Manager";
  applyRoleNavigation(profile.role);
  document.getElementById("user-avatar").textContent = initials(state.user);
  document.getElementById("top-avatar").textContent = initials(state.user);
  document.getElementById("today-label").textContent = today.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (!workspaceDirty) setSyncStatus("synced", "Synced");
  subscribeToWorkspace();
  subscribeToContractorAccess();
  renderPage();
  await loadSafetyTickets();
  handleSafetyTicketLink();
}

function subscribeToWorkspace() {
  if (workspaceChannel) supabaseClient.removeChannel(workspaceChannel);
  workspaceChannel = supabaseClient
    .channel("fieldwork-shared-workspace")
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "workspace_state", filter: "id=eq.main" }, ({ new: row }) => {
      if (!row || row.version <= workspaceVersion) return;
      if (workspaceDirty || workspaceWriteInProgress) {
        setSyncStatus("conflict", "Another user updated the workspace");
        return;
      }
      workspaceVersion = row.version;
      const removedDemoRecords = storeWorkspaceData(row.data);
      if (removedDemoRecords) {
        workspaceDirty = true;
        workspaceRevision += 1;
        setSyncStatus("pending", "Removing demo records");
        syncWorkspace();
      } else {
        setSyncStatus("synced", "Live update received");
      }
      renderPage();
    })
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("Fieldwork live updates are unavailable.", status);
        setSyncStatus(workspaceDirty ? "pending" : "synced", workspaceDirty ? "Saving changes" : "Synced · live updates unavailable");
      }
    });
}

async function loadAdminProfiles() {
  if (!supabaseClient || userProfile?.role !== "admin") return;
  const request = ++adminProfilesRequest;
  const [profilesResult, companiesResult] = await Promise.all([
    supabaseClient
      .from("profiles")
      .select("id,email,full_name,role,created_at,contractor_company_id,contractor_status,phone,job_title,employee_number,emergency_contact_name,emergency_contact_phone,profile_photo_path")
      .order("created_at", { ascending: true }),
    supabaseClient
      .from("contractor_companies")
      .select("id,name,status,created_at,gst_number,business_address,business_phone,wcb_letter_path,wcb_expires_on")
      .order("created_at", { ascending: true }),
  ]);
  if (profilesResult.error || companiesResult.error) {
    console.error("Could not load contractor access requests.", profilesResult.error || companiesResult.error);
    showToast("Unable to refresh contractor applications. Check your connection and Supabase access policies.");
    return;
  }
  if (request !== adminProfilesRequest) return;
  profilesCache = profilesResult.data || [];
  contractorCompaniesCache = companiesResult.data || [];
  if (activePage === "users") renderPage();
}

async function loadForemanProfiles() {
  if (!supabaseClient || !["admin", "manager"].includes(userProfile?.role)) return false;
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id,full_name,email,job_title,role")
    .eq("role", "foreman")
    .order("full_name", { ascending: true });
  if (error) {
    console.error("Could not load foreman accounts.", error);
    showToast("Could not load foreman accounts. Apply the foreman dashboard SQL migration.");
    return false;
  }
  foremanProfilesCache = data || [];
  return true;
}

async function refreshForemanWorkspace() {
  let workspaceResult;
  let libraryResult;
  try {
    [workspaceResult, libraryResult] = await Promise.all([
      supabaseClient.rpc("foreman_workspace_data"),
      supabaseClient.rpc("foreman_safety_library_data"),
    ]);
  } catch (error) {
    console.error("Could not refresh the assigned foreman dashboard or safety library.", error);
    showToast("Could not refresh assigned job data or the safety library. Check your connection.");
    return false;
  }
  const { data, error } = workspaceResult;
  const { data: libraryData, error: libraryError } = libraryResult;
  if (error || libraryError) {
    console.error("Could not refresh the assigned foreman dashboard or safety library.", error || libraryError);
    showToast("Could not refresh assigned job data or the safety library. Apply the safety library SQL migration.");
    return false;
  }
  storeWorkspaceData({
    ...(data || {}),
    safetyLibrary: libraryData?.documents || [],
    safetyLibraryFolders: libraryData?.folders || [],
  });
  foremanJobId = "";
  if (["foreman", "safety-library"].includes(activePage)) renderPage();
  setSyncStatus("readonly", "Read only · dashboard refreshed");
  return true;
}

function subscribeToContractorAccess() {
  if (!supabaseClient || userProfile?.role !== "admin") return;
  if (contractorAccessChannel) supabaseClient.removeChannel(contractorAccessChannel);
  contractorAccessChannel = supabaseClient
    .channel("fieldwork-contractor-access")
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => {
      if (activePage !== "users") return;
      clearTimeout(contractorAccessRefreshTimer);
      contractorAccessRefreshTimer = setTimeout(loadAdminProfiles, 150);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "contractor_companies" }, () => {
      if (activePage !== "users") return;
      clearTimeout(contractorAccessRefreshTimer);
      contractorAccessRefreshTimer = setTimeout(loadAdminProfiles, 150);
    })
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("Live contractor application updates are unavailable.", status);
      }
    });
}

async function loadContractorWorkflow() {
  if (!supabaseClient || userProfile?.role !== "contractor" || !contractorCompany) return;
  const { data: jobs, error: jobsError } = await supabaseClient.rpc("contractor_assigned_jobs");
  if (jobsError) {
    console.error("Could not load contractor job assignments.", jobsError);
    showToast("Could not load your assigned jobs. Apply the contractor workflow SQL migration.");
    contractorWorkflow = { jobs: [], rateCard: null, equipment: [], jobEquipment: [], invoices: [] };
    return;
  }
  const jobIds = (jobs || []).map((job) => job.job_id);
  const [ratesResult, equipmentResult, invoicesResult, jobEquipmentResult] = await Promise.all([
    supabaseClient.from("contractor_rate_cards").select("*").eq("company_id", contractorCompany.id).maybeSingle(),
    supabaseClient.from("contractor_company_equipment").select("id,company_id,equipment_type,name,serial_number,active").eq("company_id", contractorCompany.id).order("name"),
    supabaseClient.from("contractor_invoices").select("*").eq("company_id", contractorCompany.id).order("created_at", { ascending: false }),
    jobIds.length
      ? supabaseClient.from("contractor_job_equipment").select("job_id,equipment_id").eq("company_id", contractorCompany.id).in("job_id", jobIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const failed = [ratesResult, equipmentResult, invoicesResult, jobEquipmentResult].find((result) => result.error);
  if (failed) {
    console.error("Could not load contractor workflow data.", failed.error);
    showToast("Could not load contractor pricing, equipment, or invoices. Check the contractor workflow SQL policies.");
    return;
  }
  contractorWorkflow = {
    jobs: jobs || [],
    rateCard: ratesResult.data || null,
    equipment: equipmentResult.data || [],
    jobEquipment: jobEquipmentResult.data || [],
    invoices: invoicesResult.data || [],
  };
}

async function loadAdminContractorWorkflow() {
  if (!supabaseClient || userProfile?.role !== "admin") return;
  await loadAdminProfiles();
  const [rates, equipment, assignments, jobEquipment, invoices] = await Promise.all([
    supabaseClient.from("contractor_rate_cards").select("*"),
    supabaseClient.from("contractor_company_equipment").select("*").order("created_at", { ascending: false }),
    supabaseClient.from("contractor_job_assignments").select("company_id,job_id"),
    supabaseClient.from("contractor_job_equipment").select("company_id,job_id,equipment_id"),
    supabaseClient.from("contractor_invoices").select("*").order("created_at", { ascending: false }),
  ]);
  const failed = [rates, equipment, assignments, jobEquipment, invoices].find((result) => result.error);
  if (failed) {
    console.error("Could not load contractor workflow setup.", failed.error);
    showToast("Could not load contractor rates, equipment, assignments, or invoices. Apply the contractor workflow SQL migration.");
    return;
  }
  adminContractorRates = rates.data || [];
  adminContractorEquipment = equipment.data || [];
  adminContractorAssignments = assignments.data || [];
  adminContractorJobEquipment = jobEquipment.data || [];
  adminContractorInvoices = invoices.data || [];
  if (activePage === "contractor-work") renderPage();
}

async function loadSafetyTickets() {
  const { data, error } = await supabaseClient
    .from("safety_tickets")
    .select("id,user_id,holder_name,title,issuer,ticket_number,issued_on,expires_on,photo_path,created_at")
    .order("expires_on", { ascending: true });
  if (error) {
    console.error("Could not load safety tickets.", error);
    showToast("Unable to load safety tickets. Apply the profile and safety-ticket SQL migration.");
    return;
  }
  safetyTickets = data || [];
  if (activePage === "safety-tickets" || userProfile?.role === "contractor") renderPage();
}

function ticketExpiryStatus(ticket) {
  if (ticket.expires_on < dateOffset(0)) return "Expired";
  if (ticket.expires_on <= dateOffset(30)) return "Expiring soon";
  return "Current";
}

function ticketOwnerName(userId) {
  if (userId === authSession?.user?.id) return userProfile?.full_name || authSession?.user?.email || "You";
  return profilesCache.find((profile) => profile.id === userId)?.full_name || "Team member";
}

async function signedPhotoUrl(path) {
  if (!path) return "";
  const { data, error } = await supabaseClient.storage.from("safety-ticket-photos").createSignedUrl(path, 3600);
  if (error) {
    console.error("Could not create a private safety-photo link.", error);
    return "";
  }
  return data.signedUrl;
}

async function hydratePrivatePhotos() {
  const photoNodes = [...document.querySelectorAll("[data-private-photo]")];
  await Promise.all(photoNodes.map(async (node) => {
    const url = await signedPhotoUrl(node.dataset.privatePhoto);
    if (url) node.src = url;
  }));
}

function contractorWcbStatus(company) {
  if (!company?.wcb_letter_path || !company?.wcb_expires_on) return "WCB required · Missing";
  return company.wcb_expires_on < dateOffset(0) ? "WCB invalid · Expired" : "WCB valid";
}

function contractorWcbControls(company) {
  return `${statusPill(contractorWcbStatus(company))}${company.wcb_expires_on ? `<span class="table-secondary">Expires ${formatDate(company.wcb_expires_on, { month: "short", day: "numeric", year: "numeric" })}</span>` : ""}${company.wcb_letter_path ? `<button class="text-link" data-wcb-document="${escapeHtml(company.wcb_letter_path)}">View WCB letter</button>` : ""}<button class="button button-outline" data-action="manage-contractor-wcb" data-company-id="${escapeHtml(company.id)}">${company.wcb_letter_path ? "Update WCB letter" : "Add WCB letter"}</button>`;
}

async function openContractorWcbLetter(path) {
  const preview = window.open("about:blank", "_blank");
  if (!preview) {
    showToast("Allow pop-ups to view the private WCB letter.");
    return;
  }
  preview.opener = null;
  const { data, error } = await supabaseClient.storage.from("contractor-wcb-letters").createSignedUrl(path, 3600);
  if (error) {
    preview.close();
    console.error("Could not create a private WCB letter link.", error);
    showToast("Could not open the WCB letter. Check storage access and try again.");
    return;
  }
  preview.location = data.signedUrl;
}

function profilePhotoMarkup(path) {
  return path
    ? `<img class="profile-photo" data-private-photo="${escapeHtml(path)}" alt="Profile photo">`
    : `<span class="profile-photo-placeholder">${initials(userProfile?.full_name || state.user)}</span>`;
}

function renderMyProfile() {
  const profile = userProfile || {};
  const company = contractorCompany || {};
  const contractorFields = profile.role === "contractor"
    ? `<div class="profile-readonly-grid"><span>Company</span><strong>${escapeHtml(company.name || "—")}</strong><span>GST / tax number</span><strong>${escapeHtml(company.gst_number || "Not provided")}</strong><span>Business address</span><strong>${escapeHtml(company.business_address || "Not provided")}</strong><span>Business phone</span><strong>${escapeHtml(company.business_phone || "Not provided")}</strong></div>`
    : "";
  return `${heading("ACCOUNT", "My profile", "Keep your contact and emergency details current. Profile information is only visible to you and authorized administrators.", "")}
    <section class="card panel profile-panel">
      <div class="profile-header">${profilePhotoMarkup(profile.profile_photo_path)}<div><h2 class="panel-title">${escapeHtml(profile.full_name || state.user)}</h2><p class="panel-subtitle">${escapeHtml(profile.email || authSession?.user?.email || "")} · ${escapeHtml(profile.job_title || (profile.role === "contractor" ? company.name : profile.role))}</p></div></div>
      <form id="profile-form" class="profile-form">
        <div class="form-grid">
          ${field("Full name", "full-name", `<input class="form-input" name="full_name" value="${escapeHtml(profile.full_name || "")}" autocomplete="name" required>`)}
          ${field("Phone", "phone", `<input class="form-input" name="phone" type="tel" value="${escapeHtml(profile.phone || "")}" autocomplete="tel">`)}
          ${field("Job title", "job-title", `<input class="form-input" name="job_title" value="${escapeHtml(profile.job_title || "")}" autocomplete="organization-title">`)}
          ${field("Employee / contractor number", "employee-number", `<input class="form-input" name="employee_number" value="${escapeHtml(profile.employee_number || "")}">`)}
          ${field("Emergency contact name", "emergency-name", `<input class="form-input" name="emergency_contact_name" value="${escapeHtml(profile.emergency_contact_name || "")}">`)}
          ${field("Emergency contact phone", "emergency-phone", `<input class="form-input" name="emergency_contact_phone" type="tel" value="${escapeHtml(profile.emergency_contact_phone || "")}">`)}
          ${field("Profile photo", "profile-photo", `<input class="form-input" name="profile_photo" type="file" accept="image/jpeg,image/png,image/webp"><span class="form-hint">JPG, PNG, or WebP · maximum 10 MB</span>`)}
          ${contractorFields ? `<div class="form-field full"><label>Contractor company information</label>${contractorFields}<p class="form-hint">Ask a Fieldwork administrator to update your company’s legal and GST details.</p></div>` : ""}
        </div>
        <div class="profile-actions"><button class="button button-primary" type="submit">Save profile</button>${profile.role === "foreman" ? "" : `<button class="button button-outline" type="button" data-page="safety-tickets">Manage safety tickets</button>`}</div>
      </form>
    </section>`;
}

function renderSafetyTickets() {
  const visibleTickets = safetyTickets;
  const cards = visibleTickets.map((ticket) => {
    const expiry = ticketExpiryStatus(ticket);
    const photo = ticket.photo_path
      ? `<img class="ticket-photo" data-private-photo="${escapeHtml(ticket.photo_path)}" alt="Photo of ${escapeHtml(ticket.title)}">`
      : `<div class="ticket-photo-placeholder">No ticket photo</div>`;
    return `<article class="card safety-ticket-card">
      <div class="ticket-card-head"><div><span class="section-kicker">${escapeHtml(ticket.holder_name || ticketOwnerName(ticket.user_id))}</span><h2>${escapeHtml(ticket.title)}</h2></div>${statusPill(expiry)}</div>
      ${photo}
      <dl class="ticket-details"><div><dt>Ticket number</dt><dd>${escapeHtml(ticket.ticket_number || "—")}</dd></div><div><dt>Issuer</dt><dd>${escapeHtml(ticket.issuer || "—")}</dd></div><div><dt>Issued</dt><dd>${formatDate(ticket.issued_on, { month: "short", day: "numeric", year: "numeric" })}</dd></div><div><dt>Expires</dt><dd>${formatDate(ticket.expires_on, { month: "short", day: "numeric", year: "numeric" })}</dd></div></dl>
      <div class="ticket-actions"><button class="button button-outline" data-ticket-qr="${escapeHtml(ticket.id)}">Show QR code</button>${ticket.user_id === authSession?.user?.id ? `<button class="text-link" data-ticket-delete="${escapeHtml(ticket.id)}">Delete ticket</button>` : ""}</div>
    </article>`;
  }).join("");
  return `${heading("TRAINING & COMPLIANCE", "Safety tickets", "Store safety qualifications, expiry dates, and private ticket photos. Each ticket has an authenticated QR verification link.", actionButton("Add safety ticket", "new-safety-ticket"))}
    <div class="ticket-summary-row"><span>${visibleTickets.length} ticket${visibleTickets.length === 1 ? "" : "s"}</span><span>${visibleTickets.filter((ticket) => ticketExpiryStatus(ticket) === "Expired").length} expired</span><span>${visibleTickets.filter((ticket) => ticketExpiryStatus(ticket) === "Expiring soon").length} expiring within 30 days</span></div>
    ${cards ? `<div class="safety-ticket-grid">${cards}</div>` : `<section class="card panel"><div class="empty-state"><strong>No safety tickets yet</strong>Add a ticket and attach a photo of the certificate or card.</div></section>`}`;
}

async function saveMyProfile(form) {
  const data = new FormData(form);
  const values = {
    full_name: String(data.get("full_name") || "").trim(),
    phone: String(data.get("phone") || "").trim(),
    job_title: String(data.get("job_title") || "").trim(),
    employee_number: String(data.get("employee_number") || "").trim(),
    emergency_contact_name: String(data.get("emergency_contact_name") || "").trim(),
    emergency_contact_phone: String(data.get("emergency_contact_phone") || "").trim(),
  };
  const photo = data.get("profile_photo");
  let newPhotoPath = "";
  if (photo instanceof File && photo.size > 0) {
    if (!validatePhoto(photo)) return;
    const extension = photo.type.split("/")[1].replace("jpeg", "jpg");
    newPhotoPath = `${authSession.user.id}/profile/${uuid()}.${extension}`;
    const { error: uploadError } = await supabaseClient.storage.from("safety-ticket-photos").upload(newPhotoPath, photo, { contentType: photo.type, upsert: false });
    if (uploadError) {
      console.error("Could not upload profile photo.", uploadError);
      showToast("Could not upload the profile photo. Check the private storage setup.");
      return;
    }
    values.profile_photo_path = newPhotoPath;
  }
  const previousPhotoPath = userProfile.profile_photo_path;
  const { data: updated, error } = await supabaseClient.from("profiles").update(values).eq("id", authSession.user.id).select("*").single();
  if (error) {
    console.error("Could not save your profile.", error);
    if (newPhotoPath) await supabaseClient.storage.from("safety-ticket-photos").remove([newPhotoPath]);
    showToast("Could not save profile. Apply the profile and safety-ticket SQL migration.");
    return;
  }
  if (newPhotoPath && previousPhotoPath) {
    const { error: removeError } = await supabaseClient.storage.from("safety-ticket-photos").remove([previousPhotoPath]);
    if (removeError) console.error("Could not remove the replaced profile photo.", removeError);
  }
  userProfile = { ...userProfile, ...updated };
  const cachedProfile = profilesCache.find((profile) => profile.id === updated.id);
  if (cachedProfile) Object.assign(cachedProfile, updated);
  state.user = userProfile.full_name || state.user;
  document.getElementById("user-name").textContent = state.user;
  document.getElementById("user-avatar").textContent = initials(state.user);
  document.getElementById("top-avatar").textContent = initials(state.user);
  renderPage();
  hydratePrivatePhotos();
  showToast("Profile updated.");
}

function validatePhoto(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    showToast("Choose a JPG, PNG, or WebP image.");
    return false;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast("Photos must be 10 MB or smaller.");
    return false;
  }
  return true;
}

function validateSafetyDocument(file) {
  if (file.type !== "application/pdf") {
    showToast("Upload the safety form as a PDF.");
    return false;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast("Safety form PDFs must be 10 MB or smaller.");
    return false;
  }
  return true;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

async function storeSafetyFormDocument(file, jobId) {
  const meta = {
    documentName: file.name || "safety-form.pdf",
    documentType: file.type,
    documentSize: file.size,
    documentUploadedAt: dateOffset(0),
  };
  const keepLocally = async () => {
    if (file.size > 2 * 1024 * 1024) {
      showToast("Sign in to attach PDFs larger than 2 MB. Offline storage is limited to 2 MB.");
      return null;
    }
    try {
      return { ...meta, documentDataUrl: await readFileAsDataUrl(file) };
    } catch (error) {
      console.error("Could not read the safety form PDF.", error);
      showToast("Could not read that PDF. Try another file.");
      return null;
    }
  };
  if (!authSession || !userProfile || !supabaseClient) return keepLocally();
  const path = `${authSession.user.id}/jobs/${jobId || "unassigned"}/${uid()}.pdf`;
  const { error } = await supabaseClient.storage.from("safety-form-documents").upload(path, file, { contentType: "application/pdf", upsert: false });
  if (error) {
    console.error("Could not upload the safety form PDF.", error);
    showToast("Private storage is unavailable, so the PDF will be kept in this browser.");
    return keepLocally();
  }
  return { ...meta, documentPath: path };
}

async function openSafetyFormDocument(form) {
  if (!form) return;
  if (form.documentDataUrl) {
    const link = document.createElement("a");
    link.href = form.documentDataUrl;
    link.download = form.documentName || "safety-form.pdf";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }
  if (!form.documentPath || !supabaseClient) {
    showToast("The safety form PDF is unavailable.");
    return;
  }
  const preview = window.open("about:blank", "_blank");
  if (!preview) {
    showToast("Allow pop-ups to view the safety form PDF.");
    return;
  }
  preview.opener = null;
  const { data, error } = await supabaseClient.storage.from("safety-form-documents").createSignedUrl(form.documentPath, 3600);
  if (error) {
    preview.close();
    console.error("Could not create a private safety-form link.", error);
    showToast("Could not open the safety form PDF. Check storage access and try again.");
    return;
  }
  preview.location = data.signedUrl;
}

function canManageSafetyLibrary() {
  return ["admin", "manager"].includes(userProfile?.role);
}

async function uploadSafetyLibraryDocument(form) {
  if (!canManageSafetyLibrary() || !authSession || !supabaseClient) {
    showToast("Only workspace managers can add safety library PDFs.");
    return;
  }
  const data = new FormData(form);
  const file = data.get("file");
  if (!(file instanceof File) || !file.size) {
    showToast("Choose a safety PDF to upload.");
    return;
  }
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    showToast("Choose a PDF file.");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast("Safety library PDFs must be 10 MB or smaller.");
    return;
  }
  try {
    const header = new TextDecoder().decode(await file.slice(0, 1024).arrayBuffer());
    if (!header.includes("%PDF-")) {
      showToast("That file does not appear to be a valid PDF.");
      return;
    }
  } catch (error) {
    console.error("Could not verify the safety library PDF.", error);
    showToast("Could not read that PDF. Try another file.");
    return;
  }
  const title = String(data.get("title") || "").trim();
  if (!title) {
    showToast("Enter a title for this safety document.");
    form.elements.namedItem("title").focus();
    return;
  }
  const jobId = String(data.get("jobId") || "");
  if (jobId && !jobById(jobId)) {
    showToast("Choose a job that is still in the workspace.");
    return;
  }

  const id = uid();
  const folderSegment = safetyLibraryFolderId ? `${safetyLibraryFolderId}/` : "";
  const path = `library/${authSession.user.id}/${folderSegment}${uuid()}.pdf`;
  let error;
  try {
    ({ error } = await supabaseClient.storage
      .from("safety-form-documents")
      .upload(path, file, { contentType: "application/pdf", upsert: false }));
  } catch (uploadError) {
    console.error("Could not upload the safety library PDF.", uploadError);
    showToast("Could not upload this PDF. Check your connection and try again.");
    return;
  }
  if (error) {
    console.error("Could not upload the safety library PDF.", error);
    showToast("Could not upload this PDF. Check private storage access and try again.");
    return;
  }

  state.safetyLibrary = state.safetyLibrary || [];
  state.safetyLibrary.unshift({
    id,
    title,
    category: String(data.get("category") || "Other"),
    description: String(data.get("description") || "").trim(),
    jobId,
    fileName: file.name,
    fileSize: file.size,
    folderId: safetyLibraryFolderId,
    storagePath: path,
    uploadedBy: userProfile.full_name || authSession.user.email || "",
    uploadedAt: new Date().toISOString(),
  });
  persist();
  renderPage();
  showToast("Safety document added to the library.");
}

function updateSafetyLibraryDocumentJob(documentId, jobId) {
  if (!canManageSafetyLibrary()) {
    showToast("Only workspace managers can assign safety documents to jobs.");
    renderPage();
    return;
  }
  const item = (state.safetyLibrary || []).find((document) => document.id === documentId);
  if (!item || (jobId && !jobById(jobId))) {
    showToast("That safety document or job could not be found.");
    renderPage();
    return;
  }
  item.jobId = jobId;
  persist();
  renderPage();
  showToast(jobId ? `Safety document assigned to ${shortJobName(jobId)}.` : "Safety document unassigned from its job.");
}

function addSafetyLibraryFolder() {
  if (!canManageSafetyLibrary()) {
    showToast("Only workspace managers can add safety library folders.");
    return;
  }
  const name = window.prompt("Name this safety folder:");
  if (name === null) return;
  const trimmedName = name.trim();
  if (!trimmedName) {
    showToast("Enter a folder name.");
    return;
  }
  if (trimmedName.length > 80 || /[\\/]/.test(trimmedName)) {
    showToast("Folder names must be 80 characters or fewer and cannot contain slashes.");
    return;
  }
  state.safetyLibraryFolders = state.safetyLibraryFolders || [];
  const duplicate = state.safetyLibraryFolders.some((folder) =>
    folder.parentId === safetyLibraryFolderId && folder.name.toLowerCase() === trimmedName.toLowerCase());
  if (duplicate) {
    showToast("A folder with that name already exists here.");
    return;
  }
  const folder = { id: uuid(), name: trimmedName, parentId: safetyLibraryFolderId };
  state.safetyLibraryFolders.push(folder);
  safetyLibraryFolderId = folder.id;
  persist();
  renderPage();
  showToast("Safety folder created.");
}

function openSafetyLibraryFolder(folderId) {
  const folder = (state.safetyLibraryFolders || []).find((item) => item.id === folderId);
  if (!folder || folder.parentId !== safetyLibraryFolderId) {
    showToast("That safety folder is no longer available.");
    return;
  }
  safetyLibraryFolderId = folder.id;
  renderPage();
}

function navigateSafetyLibraryFolder(folderId = "") {
  if (folderId && !(state.safetyLibraryFolders || []).some((folder) => folder.id === folderId)) {
    showToast("That safety folder is no longer available.");
    safetyLibraryFolderId = "";
    renderPage();
    return;
  }
  safetyLibraryFolderId = folderId;
  renderPage();
}

async function openSafetyLibraryDocument(documentId) {
  const item = (state.safetyLibrary || []).find((document) => document.id === documentId);
  if (!item?.storagePath || !supabaseClient) {
    showToast("This safety library PDF is unavailable.");
    return;
  }
  const preview = window.open("about:blank", "_blank");
  if (!preview) {
    showToast("Allow pop-ups to view the safety library PDF.");
    return;
  }
  preview.opener = null;
  let data;
  let error;
  try {
    ({ data, error } = await supabaseClient.storage
      .from("safety-form-documents")
      .createSignedUrl(item.storagePath, 3600));
  } catch (linkError) {
    preview.close();
    console.error("Could not create a private safety-library link.", linkError);
    showToast("Could not open this safety PDF. Check your connection and try again.");
    return;
  }
  if (error) {
    preview.close();
    console.error("Could not create a private safety-library link.", error);
    showToast("Could not open this safety PDF. Check storage access and try again.");
    return;
  }
  preview.location = data.signedUrl;
}

async function deleteSafetyLibraryDocument(documentId) {
  if (!canManageSafetyLibrary()) {
    showToast("Only workspace managers can remove safety library PDFs.");
    return;
  }
  if (!supabaseClient) {
    showToast("Private safety document storage is unavailable.");
    return;
  }
  const item = (state.safetyLibrary || []).find((document) => document.id === documentId);
  if (!item) {
    showToast("That safety library document could not be found.");
    return;
  }
  if (!confirm(`Remove “${item.title}” from the safety library?`)) return;
  let error;
  try {
    ({ error } = await supabaseClient.storage
      .from("safety-form-documents")
      .remove([item.storagePath]));
  } catch (removeError) {
    console.error("Could not remove the safety library PDF.", removeError);
    showToast("Could not remove this PDF from private storage.");
    return;
  }
  if (error) {
    console.error("Could not remove the safety library PDF.", error);
    showToast("Could not remove this PDF from private storage.");
    return;
  }
  state.safetyLibrary = state.safetyLibrary.filter((document) => document.id !== documentId);
  persist();
  renderPage();
  showToast("Safety document removed.");
}

async function saveSafetyTicket(form) {
  const data = new FormData(form);
  const values = {
    id: uuid(),
    user_id: authSession.user.id,
    title: String(data.get("title") || "").trim(),
    issuer: String(data.get("issuer") || "").trim(),
    ticket_number: String(data.get("ticket_number") || "").trim(),
    issued_on: String(data.get("issued_on") || ""),
    expires_on: String(data.get("expires_on") || ""),
  };
  if (values.expires_on < values.issued_on) {
    showToast("The expiry date must be on or after the issue date.");
    return;
  }
  const photo = data.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    showToast("Add a photo of the safety ticket to continue.");
    return;
  }
  if (!validatePhoto(photo)) return;
  const extension = photo.type.split("/")[1].replace("jpeg", "jpg");
  const path = `${authSession.user.id}/tickets/${values.id}/${uuid()}.${extension}`;
  const { error: uploadError } = await supabaseClient.storage.from("safety-ticket-photos").upload(path, photo, { contentType: photo.type, upsert: false });
  if (uploadError) {
    console.error("Could not upload safety ticket photo.", uploadError);
    showToast("Could not upload the ticket photo. Check the private storage setup.");
    return;
  }
  values.photo_path = path;
  const { error } = await supabaseClient.from("safety_tickets").insert(values);
  if (error) {
    console.error("Could not save safety ticket.", error);
    await supabaseClient.storage.from("safety-ticket-photos").remove([path]);
    showToast("Could not save the safety ticket. Check the database policies.");
    return;
  }
  modal.close();
  await loadSafetyTickets();
  renderPage();
  hydratePrivatePhotos();
  showToast("Safety ticket saved. Its QR verification link is ready.");
}

function safetyTicketUrl(ticketId) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("ticket", ticketId);
  return url.toString();
}

function showSafetyTicketQr(ticketId) {
  const ticket = safetyTickets.find((item) => item.id === ticketId);
  if (!ticket) {
    showToast("That safety ticket is no longer available.");
    return;
  }
  modalContent.innerHTML = `<div class="modal-inner ticket-qr-modal"><div class="modal-head"><div><div class="section-kicker">AUTHENTICATED VERIFICATION</div><h2>${escapeHtml(ticket.title)}</h2><p class="panel-subtitle">${escapeHtml(ticket.holder_name || ticketOwnerName(ticket.user_id))} · Expires ${formatDate(ticket.expires_on, { month: "short", day: "numeric", year: "numeric" })}</p></div><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><div id="ticket-qr-code" class="ticket-qr-code"></div><p class="form-hint">Scan to open the ticket in Fieldwork. The verifier must sign in with an authorized account; photos are never included in the QR code.</p><div class="modal-actions"><button type="button" class="button button-outline" data-action="close-modal">Close</button></div></div>`;
  modal.showModal();
  if (!window.QRCode) {
    showToast("QR code library is unavailable. Check your internet connection.");
    return;
  }
  new window.QRCode(document.getElementById("ticket-qr-code"), {
    text: safetyTicketUrl(ticketId),
    width: 220,
    height: 220,
    correctLevel: window.QRCode.CorrectLevel.M,
  });
}

function showSafetyTicketVerification(ticket) {
  const expiry = ticketExpiryStatus(ticket);
  modalContent.innerHTML = `<div class="modal-inner ticket-verify-modal"><div class="modal-head"><div><div class="section-kicker">SAFETY TICKET VERIFICATION</div><h2>${escapeHtml(ticket.title)}</h2><p class="panel-subtitle">${escapeHtml(ticket.holder_name || ticketOwnerName(ticket.user_id))} · ${statusPill(expiry)}</p></div><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><dl class="ticket-details"><div><dt>Ticket number</dt><dd>${escapeHtml(ticket.ticket_number || "—")}</dd></div><div><dt>Issuer</dt><dd>${escapeHtml(ticket.issuer || "—")}</dd></div><div><dt>Issued</dt><dd>${formatDate(ticket.issued_on, { month: "short", day: "numeric", year: "numeric" })}</dd></div><div><dt>Expires</dt><dd>${formatDate(ticket.expires_on, { month: "short", day: "numeric", year: "numeric" })}</dd></div></dl><p class="form-hint">Verified from the Fieldwork database. Ticket photos are not shared by QR.</p><div class="modal-actions"><button type="button" class="button button-outline" data-action="close-modal">Close</button></div></div>`;
  modal.showModal();
}

function handleSafetyTicketLink() {
  const ticketId = new URLSearchParams(location.search).get("ticket");
  if (!ticketId) return;
  if (userProfile?.role === "contractor") {
    activePage = "safety-tickets";
    renderPage();
  } else {
    setPage("safety-tickets");
  }
  if (safetyTickets.some((ticket) => ticket.id === ticketId)) {
    showSafetyTicketVerification(safetyTickets.find((ticket) => ticket.id === ticketId));
  } else {
    showToast("This ticket is not available to your account, or its link is invalid.");
  }
}

async function deleteSafetyTicket(ticketId) {
  if (!confirm("Delete this safety ticket and its photo?")) return;
  const ticket = safetyTickets.find((item) => item.id === ticketId && item.user_id === authSession.user.id);
  if (!ticket) {
    showToast("You can only delete your own safety tickets.");
    return;
  }
  const { error } = await supabaseClient.from("safety_tickets").delete().eq("id", ticketId);
  if (error) {
    console.error("Could not delete safety ticket.", error);
    showToast("Could not delete this safety ticket.");
    return;
  }
  if (ticket.photo_path) {
    const { error: photoError } = await supabaseClient.storage.from("safety-ticket-photos").remove([ticket.photo_path]);
    if (photoError) console.error("Could not remove deleted ticket photo.", photoError);
  }
  await loadSafetyTickets();
  renderPage();
  showToast("Safety ticket deleted.");
}

async function saveContractorCompanyProfile(form) {
  if (userProfile?.role !== "admin") return;
  const data = new FormData(form);
  const companyId = form.dataset.recordId;
  const updates = {
    name: String(data.get("name") || "").trim(),
    gst_number: String(data.get("gst_number") || "").trim(),
    business_phone: String(data.get("business_phone") || "").trim(),
    business_address: String(data.get("business_address") || "").trim(),
  };
  const { error } = await supabaseClient.from("contractor_companies").update(updates).eq("id", companyId);
  if (error) {
    console.error("Could not save contractor company profile.", error);
    showToast("Could not save company details. Confirm the latest database migration is applied.");
    return;
  }
  const company = contractorCompaniesCache.find((item) => item.id === companyId);
  if (company) Object.assign(company, updates);
  modal.close();
  renderPage();
  showToast("Contractor company profile updated.");
}

async function saveContractorWcbClearance(form) {
  const companyId = form.dataset.recordId;
  const company = userProfile?.role === "contractor"
    ? contractorCompany
    : contractorCompaniesCache.find((item) => item.id === companyId);
  if (!company || company.id !== companyId) {
    showToast("Could not find the contractor company for this WCB letter.");
    return;
  }
  const data = new FormData(form);
  const expiresOn = String(data.get("wcb_expires_on") || "");
  const letter = data.get("wcb_letter");
  const hasNewLetter = letter instanceof File && letter.size > 0;
  if (!expiresOn) {
    showToast("Enter the WCB letter expiry date.");
    return;
  }
  if (!hasNewLetter && !company.wcb_letter_path) {
    showToast("Upload the WCB clearance letter.");
    return;
  }
  let documentPath = company.wcb_letter_path || "";
  if (hasNewLetter) {
    const allowedTypes = {
      "application/pdf": "pdf",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };
    const extension = allowedTypes[letter.type];
    if (!extension) {
      showToast("Choose a PDF, JPG, PNG, or WebP WCB letter.");
      return;
    }
    if (letter.size > 10 * 1024 * 1024) {
      showToast("WCB letters must be 10 MB or smaller.");
      return;
    }
    documentPath = `${companyId}/${uuid()}.${extension}`;
    const { error: uploadError } = await supabaseClient.storage
      .from("contractor-wcb-letters")
      .upload(documentPath, letter, { contentType: letter.type, upsert: false });
    if (uploadError) {
      console.error("Could not upload the WCB clearance letter.", uploadError);
      showToast("Could not upload the WCB letter. Check the WCB storage migration and access policies.");
      return;
    }
  }
  const { error } = await supabaseClient.rpc("set_contractor_wcb_clearance", {
    p_company_id: companyId,
    p_document_path: documentPath,
    p_expires_on: expiresOn,
  });
  if (error) {
    console.error("Could not save contractor WCB clearance.", error);
    if (hasNewLetter) {
      const { error: cleanupError } = await supabaseClient.storage.from("contractor-wcb-letters").remove([documentPath]);
      if (cleanupError) console.error("Could not remove the unregistered WCB letter upload.", cleanupError);
    }
    showToast(error.message || "Could not save the WCB clearance.");
    return;
  }
  const previousPath = company.wcb_letter_path;
  Object.assign(company, { wcb_letter_path: documentPath, wcb_expires_on: expiresOn });
  if (hasNewLetter && previousPath && previousPath !== documentPath) {
    const { error: removeError } = await supabaseClient.storage.from("contractor-wcb-letters").remove([previousPath]);
    if (removeError) console.error("Could not remove the replaced WCB letter.", removeError);
  }
  modal.close();
  renderPage();
  showToast(`WCB clearance saved · ${contractorWcbStatus(company)}.`);
}

function renderUsers() {
  const internalUsers = profilesCache.filter((profile) => profile.role !== "contractor");
  const companies = jobAssignmentCompanies();
  const quickActions = [
    ["Add company", "new-contractor", "Register a contractor company for consistent job and crew assignment."],
    ["Add client", "new-client", "Maintain the approved client list used when creating jobs."],
    ["Add crew member", "new-person", "Add a team member to an admin-managed company."],
    ["Create job", "new-job", "Set dates, company, a foreman account, and daily work."],
    ["Add equipment", "new-equipment", "Register equipment using your own name and category, then assign it to a job."],
    ["Assign daily task", "new-task", "Create a task and assign its crew and job."],
    ["Log tool run", "new-run", "Record ILI, cleaning, gauging, or other activity."],
    ["Update safety", "new-safety", "Create or update a JSA or daily hazard review."],
    ["Add invoice", "new-invoice", "Record an invoice against a registered company and job."],
  ];
  const companyRows = contractorCompaniesCache.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Contractor company</th><th>Users</th><th>Submitted</th><th>Company activation</th><th>WCB clearance</th><th></th></tr></thead><tbody>${contractorCompaniesCache.map((company) => {
      const users = profilesCache.filter((profile) => profile.contractor_company_id === company.id);
      const companyStatus = company.status === "active" ? "Active" : company.status === "rejected" ? "Declined" : company.status === "suspended" ? "Suspended" : "Awaiting approval";
      const action = company.status === "active"
        ? `<button class="button button-outline" data-company-decision="suspend" data-company-id="${escapeHtml(company.id)}">Suspend</button>`
        : company.status === "rejected" || company.status === "suspended"
          ? `<button class="button button-outline" data-company-decision="approve" data-company-id="${escapeHtml(company.id)}">Reactivate</button>`
          : `<button class="button button-primary" data-company-decision="approve" data-company-id="${escapeHtml(company.id)}">Approve company</button><button class="button button-outline" data-company-decision="reject" data-company-id="${escapeHtml(company.id)}">Decline</button>`;
      return `<tr><td><strong>${escapeHtml(company.name)}</strong><span class="table-secondary">GST / tax: ${escapeHtml(company.gst_number || "Not provided")}</span><span class="table-secondary">${escapeHtml(company.business_phone || "Phone not provided")} · ${escapeHtml(company.business_address || "Address not provided")}</span></td><td>${users.length}</td><td>${company.created_at ? formatDate(company.created_at.slice(0, 10)) : "—"}</td><td>${statusPill(companyStatus)}</td><td><div class="wcb-company-row">${contractorWcbControls(company)}</div></td><td><div class="approval-actions"><button class="button button-outline" data-edit-company="${escapeHtml(company.id)}">Company details</button>${action}</div></td></tr>`;
    }).join("")}</tbody></table></div>`
    : `<div class="empty-state"><strong>No contractor requests</strong>New contractor signups will appear here for company approval.</div>`;
  const contractorUsers = profilesCache.filter((profile) => profile.role === "contractor");
  const userRows = contractorUsers.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>User</th><th>Company</th><th>Request date</th><th>User activation</th><th></th></tr></thead><tbody>${contractorUsers.map((profile) => {
      const company = contractorCompaniesCache.find((item) => item.id === profile.contractor_company_id);
      const companyActive = company?.status === "active";
      const memberStatus = profile.contractor_status === "active" ? "Active" : profile.contractor_status === "rejected" ? "Declined" : profile.contractor_status === "suspended" ? "Suspended" : "Awaiting approval";
      let action = profile.contractor_status === "active"
        ? `<button class="button button-outline" data-member-decision="suspend" data-member-id="${escapeHtml(profile.id)}">Suspend user</button>`
        : `<button class="button button-primary" data-member-decision="approve" data-member-id="${escapeHtml(profile.id)}" ${companyActive ? "" : "disabled"}>Approve user</button>${profile.contractor_status === "pending" ? `<button class="button button-outline" data-member-decision="reject" data-member-id="${escapeHtml(profile.id)}">Decline</button>` : ""}`;
      if (profile.contractor_status === "rejected" || profile.contractor_status === "suspended") {
        action = `<button class="button button-outline" data-member-decision="approve" data-member-id="${escapeHtml(profile.id)}" ${companyActive ? "" : "disabled"}>Reactivate</button>`;
      }
      if (profile.id === authSession?.user?.id) action = "";
      return `<tr><td><strong>${escapeHtml(profile.full_name || "Unnamed user")}</strong><span class="table-secondary">${escapeHtml(profile.job_title || "Role not provided")} · ${escapeHtml(profile.phone || "Phone not provided")}</span><span class="table-secondary">${escapeHtml(profile.email || "")}</span></td><td>${escapeHtml(company?.name || "Company unavailable")}</td><td>${profile.created_at ? formatDate(profile.created_at.slice(0, 10)) : "—"}</td><td>${statusPill(companyActive ? memberStatus : `Company ${company?.status || "unavailable"}`)}</td><td><div class="approval-actions">${action}</div></td></tr>`;
    }).join("")}</tbody></table></div>`
    : `<div class="empty-state"><strong>No contractor users</strong>Individual company users will appear here after requesting contractor access.</div>`;
  return `${heading("WORKSPACE ADMIN", "Admin panel", "Manage companies, crews, jobs, equipment, field work, and user access from one place.", `<button class="button button-outline" data-action="refresh-contractor-applications">Refresh data</button>`)}
    <div class="metric-grid">
      <article class="card metric-card"><div class="metric-top">Companies <span class="metric-icon">▤</span></div><div class="metric-value">${companies.length}</div><div class="metric-note">Available for crew setup</div></article>
      <article class="card metric-card"><div class="metric-top">Crew members <span class="metric-icon">♙</span></div><div class="metric-value">${state.people.length}</div><div class="metric-note">Added to workspace companies</div></article>
      <article class="card metric-card"><div class="metric-top">Jobs <span class="metric-icon">▦</span></div><div class="metric-value">${state.jobs.length}</div><div class="metric-note">Scheduled and active work</div></article>
      <article class="card metric-card"><div class="metric-top">Equipment <span class="metric-icon">⚙</span></div><div class="metric-value">${state.equipment.length}</div><div class="metric-note">Registered field assets</div></article>
    </div>
    <section class="card panel admin-add-panel"><div class="panel-head"><div><h2 class="panel-title">Add and manage workspace data</h2><p class="panel-subtitle">Registered clients, companies, and team members populate job assignment dropdowns.</p></div></div><div class="admin-quick-actions">${quickActions.map(([label, action, description]) => `<article class="admin-quick-card"><strong>${label}</strong><p>${description}</p><button class="button button-outline" data-action="${action}">＋ ${label}</button></article>`).join("")}</div></section>
    <section class="card panel approval-panel"><div class="panel-head"><div><h2 class="panel-title">Registered clients (${state.clients.length})</h2><p class="panel-subtitle">Jobs can only be assigned to a client from this list.</p></div><button class="button button-primary" data-action="new-client">＋ Add client</button></div>${state.clients.length ? `<div class="crew-strip">${state.clients.map((client) => `<span class="status-pill status-gray">${escapeHtml(client.name)}</span>`).join("")}</div>` : `<div class="empty-state"><strong>No clients registered</strong>Add clients here before creating jobs.</div>`}</section>
    <section class="card panel approval-panel"><div class="panel-head"><div><h2 class="panel-title">Registered workspace companies</h2><p class="panel-subtitle">Companies configured for jobs, crew members, and invoices.</p></div><button class="button button-primary" data-action="new-contractor">＋ Add company</button></div>${companies.length ? `<div class="crew-strip">${companies.map((company) => `<span class="status-pill status-gray">${escapeHtml(company.name)}</span>`).join("")}</div>` : `<div class="empty-state"><strong>No companies added</strong>Add a company to start assigning crew and jobs.</div>`}</section>
    <section class="card panel approval-panel"><div class="panel-head"><div><h2 class="panel-title">Contractor applications</h2><p class="panel-subtitle">Activate contractor companies, then approve or manage each individual account.</p></div></div>
    <section class="card panel approval-panel"><div class="panel-head"><div><h2 class="panel-title">1. Contractor companies</h2><p class="panel-subtitle">Approving a company does not automatically approve any of its users.</p></div></div>${companyRows}</section>
    <section class="card panel approval-panel"><div class="panel-head"><div><h2 class="panel-title">2. Company users</h2><p class="panel-subtitle">Each user requires separate approval after their company is active.</p></div></div>${userRows}</section>
    <section class="card panel approval-panel"><div class="panel-head"><div><h2 class="panel-title">Internal team access</h2><p class="panel-subtitle">Manage Fieldwork administrators, managers, and job-scoped foremen.</p></div></div>
    ${internalUsers.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Name & contact</th><th>Emergency contact</th><th>Joined</th><th>Access role</th></tr></thead><tbody>${internalUsers.map((profile) => `<tr><td><strong>${escapeHtml(profile.full_name || "Unnamed user")}</strong>${profile.id === authSession?.user?.id ? " (you)" : ""}<span class="table-secondary">${escapeHtml(profile.job_title || "Role not provided")} · ${escapeHtml(profile.phone || "Phone not provided")}</span><span class="table-secondary">${escapeHtml(profile.email || "")}</span></td><td>${escapeHtml(profile.emergency_contact_name || "Not provided")}<span class="table-secondary">${escapeHtml(profile.emergency_contact_phone || "")}</span></td><td>${profile.created_at ? formatDate(profile.created_at.slice(0, 10)) : "—"}</td><td><select class="form-input role-select" data-user-role="${escapeHtml(profile.id)}" aria-label="Role for ${escapeHtml(profile.email || "user")}">${["pending", "manager", "admin", "foreman"].map((role) => `<option value="${role}" ${profile.role === role ? "selected" : ""}>${role[0].toUpperCase()}${role.slice(1)}</option>`).join("")}</select></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state">Loading internal users…</div>`}
    </section></section>`;
}

async function changeUserRole(userId, role) {
  if (!["pending", "manager", "admin", "foreman"].includes(role) || userProfile?.role !== "admin") return;
  if (userId === authSession.user.id && role !== "admin") {
    showToast("You cannot remove your own admin role.");
    renderPage();
    return;
  }
  const { error } = await supabaseClient.rpc("admin_update_profile_access", {
    p_user_id: userId,
    p_role: role,
    p_contractor_status: null,
  });
  if (error) {
    console.error("Could not update workspace user role.", error);
    showToast("Could not update that user's role. Check the Supabase policies.");
    await loadAdminProfiles();
    return;
  }
  showToast("Workspace access updated.");
  await loadAdminProfiles();
}

async function decideContractorCompany(companyId, decision) {
  const status = decision === "approve" ? "active" : decision === "reject" ? "rejected" : "suspended";
  const { error } = await supabaseClient
    .from("contractor_companies")
    .update({ status })
    .eq("id", companyId);
  if (error) {
    console.error("Could not update contractor company activation.", error);
    showToast("Could not update the company. Check the database policies and try again.");
    return;
  }
  showToast(status === "active" ? "Contractor company activated. Approve each user separately." : `Contractor company ${status}.`);
  await loadAdminProfiles();
}

async function decideContractorMember(userId, decision) {
  const nextStatus = decision === "approve" ? "active" : decision === "reject" ? "rejected" : "suspended";
  const profile = profilesCache.find((item) => item.id === userId);
  const company = contractorCompaniesCache.find((item) => item.id === profile?.contractor_company_id);
  if (decision === "approve" && company?.status !== "active") {
    showToast("Activate the contractor company before approving its users.");
    return;
  }
  const { error } = await supabaseClient.rpc("admin_update_profile_access", {
    p_user_id: userId,
    p_role: null,
    p_contractor_status: nextStatus,
  });
  if (error) {
    console.error("Could not update contractor user activation.", error);
    showToast("Could not update this user. Check the database policies and try again.");
    return;
  }
  showToast(nextStatus === "active" ? "Contractor user activated." : `Contractor user ${nextStatus}.`);
  await loadAdminProfiles();
}

function renderContractorPortal() {
  const jobs = contractorWorkflow.jobs;
  const companyEquipment = contractorWorkflow.equipment;
  const selectedEquipment = (jobId) => contractorWorkflow.jobEquipment
    .filter((item) => item.job_id === jobId)
    .map((item) => companyEquipment.find((asset) => asset.id === item.equipment_id))
    .filter(Boolean);
  const ownsCompany = contractorCompany?.owner_user_id === userProfile?.id;
  const rateCard = contractorWorkflow.rateCard;
  const rateText = rateCard
    ? `Hourly ${money(rateCard.hourly_rate)}/hr · Subsistence ${money(rateCard.subsistence_daily_rate)}/day · Equipment rates are set by type.`
    : "Your company pricing has not been configured yet.";
  return `${heading("CONTRACTOR PORTAL", "Account activated", "Your company and individual account have both been approved.", "")}
    <section class="card panel contractor-welcome">
      <span class="live-pill"><span></span> ACTIVE CONTRACTOR</span>
      <h2>${escapeHtml(contractorCompany?.name || "Contractor company")}</h2>
      <p>Your login is approved for contractor access. Only jobs assigned to your company are shown here.</p>
      <div class="contractor-activation-details"><span>Signed in as</span><strong>${escapeHtml(authSession?.user?.email || "")}</strong><span>Company status</span><strong>Active</strong><span>Your user status</span><strong>Active</strong></div>
      <p class="panel-subtitle">${escapeHtml(rateText)}</p>
      <div class="profile-actions"><button class="button button-outline" data-page="profile">My profile</button><button class="button button-outline" data-page="safety-tickets">Safety tickets</button><button class="button button-primary" data-action="new-contractor-invoice" ${rateCard && jobs.length ? "" : "disabled"}>Create invoice</button>${ownsCompany ? `<button class="button button-outline" data-action="new-employee-invite">Invite employee</button>` : ""}</div>
    </section>
    <section class="card panel contractor-work-panel"><div class="panel-head"><div><h2 class="panel-title">WCB clearance</h2><p class="panel-subtitle">A current clearance letter and expiry date are required for every contractor company.</p></div></div><div class="wcb-company-row">${contractorWcbControls(contractorCompany)}</div></section>
    <section class="card panel contractor-work-panel"><div class="panel-head"><div><h2 class="panel-title">Assigned jobs & calendar</h2><p class="panel-subtitle">Job dates and equipment approved for your company</p></div></div>${renderContractorJobCalendar()}${jobs.length ? `<div class="contractor-job-list">${jobs.map((job) => {
      const assets = selectedEquipment(job.job_id);
      return `<article class="contractor-job-card"><div><span class="table-secondary">${formatDate(job.start_date, { month: "short", day: "numeric", year: "numeric" })}${job.end_date && job.end_date !== job.start_date ? ` – ${formatDate(job.end_date, { month: "short", day: "numeric", year: "numeric" })}` : ""}</span><strong>${escapeHtml(job.job_name)}</strong><span>${escapeHtml(job.client)}${job.location ? ` · ${escapeHtml(job.location)}` : ""}</span></div><div>${statusPill(job.status)}<span class="table-secondary">${assets.length ? `Equipment: ${assets.map((asset) => escapeHtml(asset.name)).join(", ")}` : "No equipment assigned"}</span></div><button class="button button-outline" data-action="new-contractor-invoice" data-job-id="${escapeHtml(job.job_id)}" ${rateCard ? "" : "disabled"}>Invoice</button></article>`;
    }).join("")}</div>` : `<div class="empty-state"><strong>No jobs assigned</strong>Contact Fieldwork to be assigned to a job before submitting an invoice.</div>`}</section>
    ${renderContractorAssetRegister()}
    <section class="card panel contractor-work-panel invoice-export-section"><div class="panel-head"><div><h2 class="panel-title">Company invoices</h2><p class="panel-subtitle">Invoice amounts are calculated from admin-approved pricing; Alberta GST (5%) is added to the subtotal.</p></div><div class="heading-actions"><button class="button button-outline" data-action="invoice-excel">Export Excel</button><button class="button button-outline" data-action="invoice-print">Print / Save PDF</button></div></div>${contractorWorkflow.invoices.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Invoice</th><th>Job</th><th>Work date</th><th>Subtotal</th><th>Alberta GST (5%)</th><th>Total (CAD)</th><th>Status</th><th>Admin notes</th></tr></thead><tbody>${contractorWorkflow.invoices.map((invoice) => `<tr><td><strong>${escapeHtml(invoice.invoice_number)}</strong></td><td>${escapeHtml(jobs.find((job) => job.job_id === invoice.job_id)?.job_name || invoice.job_id)}</td><td>${formatDate(invoice.work_date)}</td><td>${money(invoice.amount)}</td><td>${money(gstFor(invoice.amount))}</td><td><strong>${money(invoiceTotal(invoice.amount))}</strong></td><td>${statusPill(invoice.status)}</td><td>${escapeHtml(invoice.admin_notes || "—")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No invoices yet</strong>Use an assigned job to create an invoice.</div>`}</section>`;
}

function renderContractorAssetRegister() {
  const assets = contractorWorkflow.equipment;
  const jobNamesForAsset = (assetId) => contractorWorkflow.jobEquipment
    .filter((assignment) => assignment.equipment_id === assetId)
    .map((assignment) => contractorWorkflow.jobs.find((job) => job.job_id === assignment.job_id)?.job_name)
    .filter(Boolean);
  const activeCount = assets.filter((asset) => asset.active).length;
  const assignedCount = assets.filter((asset) => jobNamesForAsset(asset.id).length > 0).length;
  return `<section class="card panel contractor-work-panel"><div class="panel-head"><div><h2 class="panel-title">Company asset register</h2><p class="panel-subtitle">Assets owned by your company and the assigned Fieldwork jobs they are enabled for</p></div></div>
    <div class="contractor-asset-summary"><span>${assets.length} owned</span><span>${assignedCount} assigned to jobs</span><span>${activeCount} active</span></div>
    ${assets.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Asset</th><th>Type</th><th>Ownership</th><th>Assigned job(s)</th><th>Status</th></tr></thead><tbody>${assets.map((asset) => {
      const assignedJobs = jobNamesForAsset(asset.id);
      return `<tr><td><strong>${escapeHtml(asset.name)}</strong><span class="table-secondary">${escapeHtml(asset.serial_number)}</span></td><td>${escapeHtml(asset.equipment_type.toUpperCase())}</td><td>${statusPill("Company owned")}</td><td>${assignedJobs.length ? assignedJobs.map((name) => escapeHtml(name)).join(", ") : "Not assigned to a job"}</td><td>${statusPill(asset.active ? "Active" : "Inactive")}</td></tr>`;
    }).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No company assets registered</strong>Ask a Fieldwork administrator to add equipment owned by your company.</div>`}
  </section>`;
}

function renderContractorJobCalendar() {
  const y = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const firstDay = new Date(y, month, 1).getDay();
  const daysInMonth = new Date(y, month + 1, 0).getDate();
  const previousMonthDays = new Date(y, month, 0).getDate();
  const monthLabel = calendarDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  let days = "";
  for (let index = 0; index < 42; index++) {
    let dayNumber;
    let date;
    let dim = false;
    if (index < firstDay) {
      dayNumber = previousMonthDays - firstDay + index + 1;
      date = new Date(y, month - 1, dayNumber);
      dim = true;
    } else if (index >= firstDay + daysInMonth) {
      dayNumber = index - firstDay - daysInMonth + 1;
      date = new Date(y, month + 1, dayNumber);
      dim = true;
    } else {
      dayNumber = index - firstDay + 1;
      date = new Date(y, month, dayNumber);
    }
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const scheduledJobs = contractorWorkflow.jobs.filter((job) => job.start_date && job.start_date <= key && key <= (job.end_date || job.start_date)).slice(0, 2);
    days += `<div class="calendar-day ${dim ? "dim" : ""} ${key === dateOffset(0) ? "today" : ""}"><span class="day-number">${dayNumber}</span>${scheduledJobs.map((job) => `<div class="calendar-event" title="${escapeHtml(job.job_name)}">${escapeHtml(job.job_name)}</div>`).join("")}</div>`;
  }
  return `<div class="calendar-toolbar"><strong class="calendar-month">${monthLabel}</strong><div class="calendar-controls"><button type="button" data-action="calendar-prev" aria-label="Previous month">‹</button><button type="button" data-action="calendar-today">Today</button><button type="button" data-action="calendar-next" aria-label="Next month">›</button></div></div><div class="calendar-grid">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<div class="weekday">${day}</div>`).join("")}${days}</div>`;
}

async function initializeSupabase() {
  const config = window.FIELDWORK_SUPABASE_CONFIG || {};
  if (!config.url || !config.anonKey || !window.supabase?.createClient) {
    setSyncStatus("error", "Supabase setup required");
    showAuthMessage("Set your Supabase project URL and public anon/publishable key in supabase-config.js.");
    return;
  }
  supabaseClient = window.supabase.createClient(config.url.replace(/\/rest\/v1\/?$/, ""), config.anonKey);
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    console.error("Could not restore Supabase session.", error);
    showAuthMessage("Could not restore your sign-in. Please refresh and try again.", true);
    return;
  }
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      authSession = null;
      userProfile = null;
      contractorCompany = null;
      contractorWorkflow = { jobs: [], rateCard: null, equipment: [], jobEquipment: [], invoices: [] };
      adminContractorRates = [];
      adminContractorEquipment = [];
      adminContractorAssignments = [];
      adminContractorJobEquipment = [];
      adminContractorInvoices = [];
      foremanProfilesCache = [];
      personalWorkspaceRequest += 1;
      personalWorkspaceData = { userId: "", workspaces: [], modules: [], selectedId: "", editModuleId: "", loaded: false, error: "" };
      workspaceDirty = false;
      if (workspaceChannel) supabaseClient.removeChannel(workspaceChannel);
      if (contractorAccessChannel) supabaseClient.removeChannel(contractorAccessChannel);
      contractorAccessChannel = null;
      clearTimeout(contractorAccessRefreshTimer);
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (error) {
        console.error("Could not clear the local Fieldwork cache after sign-out.", error);
      }
      state = initialState();
      activePage = "overview";
      document.getElementById("app").classList.add("hidden");
      document.getElementById("app").classList.remove("contractor-only");
      document.getElementById("app").classList.remove("foreman-only");
      applyRoleNavigation("");
      document.getElementById("login-screen").classList.remove("hidden");
      setSyncStatus("synced", "Signed out");
    }
  });
  if (data.session) {
    try {
      await startWorkspace(data.session);
    } catch (error) {
      console.error("Could not open Fieldwork workspace.", error);
      await supabaseClient.auth.signOut();
      showAuthMessage(error.message || "Could not open the shared workspace.", true);
    }
  } else {
    setSyncStatus("synced", "Sign in to sync");
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function addAssistantMessage(role, text, taskDraftId = "") {
  assistantMessages.push({ role, text, taskDraftId });
  renderAssistantMessages();
}

function renderAssistantMessages() {
  const container = document.getElementById("assistant-messages");
  container.innerHTML = assistantMessages.map((message) => `<div class="assistant-message ${message.role}">${escapeHtml(message.text)}${message.taskDraftId ? `<button class="assistant-message-action" data-confirm-assistant-task="${escapeHtml(message.taskDraftId)}">Create this task</button>` : ""}</div>`).join("");
  container.scrollTop = container.scrollHeight;
}

function setAssistantOpen(open) {
  assistantPanel.classList.toggle("hidden", !open);
  assistantPanel.setAttribute("aria-hidden", String(!open));
  document.getElementById("assistant-toggle").setAttribute("aria-expanded", String(open));
  if (open && assistantMessages.length === 0) {
    addAssistantMessage("assistant", `Hi ${state.user.split(" ")[0] || "there"} — I can look up information in your shared workspace.\n\nTry asking what's missing before work starts, for a job or crew briefing, or about today's schedule, safety forms and tickets, contractor WCB clearances, invoices, equipment, and GPS site data. I can also prepare a task for you to confirm.`);
  }
  if (open) document.getElementById("assistant-input").focus();
}

function assistantJobMatch(query) {
  const normalized = query.trim().toLowerCase();
  return state.jobs.filter((job) => job.name.toLowerCase() === normalized || job.name.toLowerCase().includes(normalized));
}

function assistantPersonMatch(query) {
  const normalized = query.trim().toLowerCase();
  return state.people.filter((person) => person.name.toLowerCase() === normalized || person.name.toLowerCase().includes(normalized));
}

const DAILY_SAFETY_PATTERN = /(daily hazard|dhla|flha|tailgate|field level hazard|hazard assessment)/i;

function assistantMentionedJob(query) {
  const normalized = query.toLowerCase();
  const hasWord = (text) => new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(normalized);
  return state.jobs.find((job) => {
    const words = job.name.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 2 || /^\d+$/.test(part));
    return words.length > 0 && words.filter((part) => hasWord(part)).length >= Math.min(2, words.length);
  });
}

function assistantMentionedPerson(query) {
  const normalized = query.toLowerCase();
  const hasWord = (text) => new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(normalized);
  return state.people.find((person) => {
    const parts = person.name.toLowerCase().split(/\s+/).filter(Boolean);
    return parts.length > 0 && parts.every((part) => hasWord(part));
  });
}

function jobWorkDates(job) {
  const planned = (job.dailyPlan || []).map((day) => day.date).filter(Boolean);
  if (planned.length) return planned;
  if (job.startDate && job.endDate) return datesBetween(job.startDate, job.endDate).slice(0, 60);
  return job.date ? [job.date] : [];
}

function dailySafetyForm(jobId, date) {
  return state.safety.find((form) => form.jobId === jobId && form.workDate === date && DAILY_SAFETY_PATTERN.test(form.title || ""));
}

function workspaceGapGroups() {
  const groups = [];
  const add = (key, label, items) => { if (items.length) groups.push({ key, label, items }); };
  const today = dateOffset(0);
  const activeJobs = state.jobs.filter((job) => job.status !== "Complete");

  add("coverage", "FLHA / tailgate sign-offs missing", activeJobs.flatMap((job) => jobWorkDates(job)
    .filter((date) => date >= dateOffset(-14) && date <= today)
    .filter((date) => !dailySafetyForm(job.id, date))
    .map((date) => ({
      kind: "coverage", jobId: job.id,
      primary: `${job.name} — no FLHA or tailgate record`,
      secondary: formatDate(date, { weekday: "short", month: "short", day: "numeric" }),
    }))));

  add("safety", "Safety forms not signed off", state.safety
    .filter((form) => form.status !== "Current")
    .slice()
    .sort((first, second) => String(first.workDate || first.updated).localeCompare(String(second.workDate || second.updated)))
    .map((form) => ({
      kind: "safety", id: form.id, jobId: form.jobId,
      primary: `${form.title} · ${shortJobName(form.jobId)}`,
      secondary: [form.workDate ? formatDate(form.workDate) : `updated ${formatDate(form.updated)}`, form.owner, form.status].filter(Boolean).join(" · "),
    })));

  add("reports", "Daily reports not submitted", state.reports
    .filter((report) => report.status !== "Submitted" && report.date >= dateOffset(-30) && report.date <= today)
    .slice()
    .sort((first, second) => String(first.date).localeCompare(String(second.date)))
    .map((report) => ({
      kind: "report", id: report.id, jobId: report.jobId,
      primary: `${shortJobName(report.jobId)} — daily report outstanding`,
      secondary: formatDate(report.date, { weekday: "short", month: "short", day: "numeric" }),
    })));

  add("tasks", "Overdue crew tasks", state.tasks
    .filter((task) => !task.done && task.due && task.due < today)
    .slice()
    .sort((first, second) => String(first.due).localeCompare(String(second.due)))
    .map((task) => ({
      kind: "task", id: task.id,
      primary: task.title,
      secondary: `${task.assignee} · due ${formatDate(task.due)} · ${jobNames(task.jobIds)}`,
    })));

  add("wcb", "Contractor WCB clearance", contractorCompaniesCache
    .filter((company) => company.status !== "declined" && contractorWcbStatus(company) !== "WCB valid")
    .map((company) => ({
      kind: "wcb", id: company.id,
      primary: `${company.name} — ${contractorWcbStatus(company)}`,
      secondary: company.wcb_expires_on ? `letter on file expired ${formatDate(company.wcb_expires_on, { month: "short", day: "numeric", year: "numeric" })}` : "no clearance letter on file",
    })));

  add("tickets", "Safety tickets expiring or expired", safetyTickets
    .filter((ticket) => ticketExpiryStatus(ticket) !== "Current")
    .map((ticket) => ({
      kind: "ticket",
      primary: `${ticket.title} — ${ticketOwnerName(ticket.user_id)}`,
      secondary: `${ticketExpiryStatus(ticket)} · expires ${formatDate(ticket.expires_on)}`,
    })));

  add("closeout", "Jobs awaiting close-out", activeJobs
    .filter((job) => (job.endDate || job.date) < today && (job.endDate || job.date) >= dateOffset(-60) && !job.finalReport)
    .map((job) => ({
      kind: "job", jobId: job.id,
      primary: `${job.name} — no final summary`,
      secondary: `ended ${formatDate(job.endDate || job.date)}`,
    })));

  return groups;
}

function gapText(item) {
  return item.secondary ? `${item.primary} — ${item.secondary}` : item.primary;
}

function assistantGapAnswer() {
  const groups = workspaceGapGroups();
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  if (!total) {
    return "Readiness check — nothing is missing right now. Safety forms, FLHA / tailgate sign-offs, daily reports, crew tasks, contractor WCB clearances, and safety tickets are all current.";
  }
  const lines = groups.map((group) => {
    const shown = group.items.slice(0, 4).map((item) => `• ${gapText(item)}`);
    if (group.items.length > shown.length) shown.push(`• +${group.items.length - shown.length} more`);
    return `${group.label} (${group.items.length})\n${shown.join("\n")}`;
  });
  return `Readiness check — ${total} item${total === 1 ? " needs" : "s need"} attention before field work:\n\n${lines.join("\n\n")}`;
}

function assistantJobBriefing(job) {
  const today = dateOffset(0);
  const todaysPlan = (job.dailyPlan || []).find((day) => day.date === today);
  const openReports = state.reports.filter((report) => report.jobId === job.id && report.status !== "Submitted" && report.date <= today);
  const openSafety = state.safety.filter((form) => form.jobId === job.id && form.status !== "Current");
  const openTasks = state.tasks.filter((task) => !task.done && (task.jobIds || []).includes(job.id));
  const safetyDocs = state.safety.filter((form) => form.jobId === job.id && (form.documentPath || form.documentDataUrl));
  const jobTimesheets = foremanTimesheets(job.id);
  const jobTimeTotals = timesheetTotals(jobTimesheets);
  const features = Array.isArray(job.gpsWorkspace?.features) ? job.gpsWorkspace.features : [];
  const scope = job.scopeOfWork || {};
  const lines = [
    `Job briefing — ${job.name}`,
    `• Client: ${job.client || "not set"} · Location: ${job.location || "not set"}`,
    `• Dates: ${formatDate(job.startDate || job.date)} – ${formatDate(job.endDate || job.date)} · ${job.status || "Scheduled"} · ${Number(job.progress) || 0}% complete`,
    `• Foreman: ${jobForemanName(job) || "unassigned"}${job.crewMembers?.length ? ` · Crew: ${job.crewMembers.join(", ")}` : ""}`,
    `• Company: ${job.companyName || "not set"}`,
    `• Today's plan: ${todaysPlan ? ((todaysPlan.tasks || []).join("; ") || "no tasks listed") : "no planned tasks"}${todaysPlan?.assignee ? ` (${todaysPlan.assignee})` : ""}`,
    `• Open tasks: ${openTasks.length}${openTasks.length ? ` — ${openTasks.slice(0, 3).map((task) => task.title).join("; ")}${openTasks.length > 3 ? "; …" : ""}` : ""}`,
    `• Safety: ${openSafety.length ? `${openSafety.length} form(s) not signed off — ${openSafety.slice(0, 3).map((form) => `${form.title}${form.workDate ? ` (${formatDate(form.workDate)})` : ""}`).join("; ")}` : "all forms current"}`,
    `• Safety form PDFs: ${safetyDocs.length ? `${safetyDocs.length} attached — ${safetyDocs.slice(0, 3).map((form) => form.documentName || form.title).join("; ")}${safetyDocs.length > 3 ? "; …" : ""}` : "none attached"}`,
    `• Daily reports: ${openReports.length ? `${openReports.length} outstanding (${openReports.slice(0, 3).map((report) => formatDate(report.date)).join(", ")}${openReports.length > 3 ? ", …" : ""})` : "all submitted"}`,
    `• Timesheets: ${jobTimesheets.length ? `${hoursLabel(jobTimeTotals.today)} today · ${hoursLabel(jobTimeTotals.week)} this week` : "no time recorded"}`,
  ];
  if (job.siteCoordinate) lines.push(`• Site coordinates: ${Number(job.siteCoordinate.lat).toFixed(5)}, ${Number(job.siteCoordinate.lon).toFixed(5)} · ${features.length} saved map feature${features.length === 1 ? "" : "s"}`);
  else if (features.length) lines.push(`• GPS workspace: ${features.length} saved map feature${features.length === 1 ? "" : "s"}`);
  if (scope.deliverables) lines.push(`• Deliverables: ${scope.deliverables}`);
  if (scope.acceptanceCriteria) lines.push(`• Acceptance: ${scope.acceptanceCriteria}`);
  return lines.join("\n");
}

function assistantPersonBriefing(person) {
  const company = jobAssignmentCompanies().find((item) => item.id === person.companyId);
  const jobs = state.jobs.filter((job) => job.crewLead === person.name
    || (job.crewMembers || []).includes(person.name)
    || (person.jobIds || []).includes(job.id));
  const tasks = state.tasks.filter((task) => !task.done && task.assignee === person.name);
  const forms = state.safety.filter((form) => form.owner === person.name && form.status !== "Current");
  const tickets = safetyTickets.filter((ticket) => ticketOwnerName(ticket.user_id) === person.name);
  return [
    `Crew briefing — ${person.name}`,
    `• Role: ${person.role || "crew member"} · Company: ${company?.name || "workspace team"}`,
    `• Jobs: ${jobs.length ? jobs.map((job) => `${job.name} (${job.status || "Scheduled"})`).join("; ") : "no job assignments"}`,
    `• Open tasks: ${tasks.length ? tasks.slice(0, 5).map((task) => `${task.title} (due ${formatDate(task.due)})`).join("; ") : "none"}`,
    `• Safety forms owned: ${forms.length ? forms.slice(0, 4).map((form) => `${form.title} — ${form.status}`).join("; ") : "all current"}`,
    `• Safety tickets: ${tickets.length ? tickets.map((ticket) => `${ticket.title} (${ticketExpiryStatus(ticket)}, expires ${formatDate(ticket.expires_on)})`).join("; ") : "none on file"}`,
  ].join("\n");
}

function assistantUpcomingAnswer() {
  const start = dateOffset(0);
  const end = dateOffset(7);
  const jobs = state.jobs.filter((job) => {
    const jobStart = job.startDate || job.date;
    const jobEnd = job.endDate || job.date;
    return jobStart && jobEnd && jobStart <= end && jobEnd >= start;
  });
  const tasks = state.tasks.filter((task) => !task.done && task.due && task.due >= start && task.due <= end);
  const runs = state.runs.filter((run) => run.date >= start && run.date <= end);
  return [
    "Next 7 days",
    `• Jobs: ${jobs.length ? jobs.map((job) => `${job.name} (${formatDate(job.startDate || job.date)} – ${formatDate(job.endDate || job.date)}, ${job.status || "Scheduled"})`).join("; ") : "none scheduled"}`,
    `• Tool runs: ${runs.length ? runs.map((run) => `${formatDate(run.date)} ${run.type} — ${shortJobName(run.jobId)} (${run.status})`).join("; ") : "none scheduled"}`,
    `• Tasks due: ${tasks.length ? tasks.slice(0, 6).map((task) => `${task.title} — ${task.assignee} (${formatDate(task.due)})`).join("; ") : "none due"}`,
  ].join("\n");
}

function assistantWorkspaceSummary() {
  const activeJobs = state.jobs.filter((job) => job.status !== "Complete");
  const averageProgress = state.jobs.length ? Math.round(state.jobs.reduce((sum, job) => sum + (Number(job.progress) || 0), 0) / state.jobs.length) : 0;
  const runs = state.runs.filter((run) => run.date >= dateOffset(-30));
  const runsByType = runs.reduce((totals, run) => { totals[run.type] = (totals[run.type] || 0) + 1; return totals; }, {});
  const pendingInvoices = state.invoices.filter((invoice) => invoice.status === "Pending");
  const pendingSubtotal = pendingInvoices.reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
  const openTasks = state.tasks.filter((task) => !task.done);
  const overdueTasks = openTasks.filter((task) => task.due && task.due < dateOffset(0));
  const gapCount = workspaceGapGroups().reduce((sum, group) => sum + group.items.length, 0);
  return [
    "Workspace summary",
    `• Jobs: ${state.jobs.length} total · ${activeJobs.length} active · ${averageProgress}% average progress`,
    `• Tool runs (30 days): ${runs.length}${runs.length ? ` — ${Object.entries(runsByType).map(([type, count]) => `${type} ${count}`).join(" · ")}` : ""}`,
    `• Tasks: ${openTasks.length} open · ${overdueTasks.length} overdue`,
    `• Safety: ${state.safety.filter((form) => form.status === "Current").length}/${state.safety.length} forms current · ${safetyTickets.filter((ticket) => ticketExpiryStatus(ticket) !== "Current").length} ticket(s) expiring or expired`,
    `• Contractors: ${pendingInvoices.length} invoice(s) pending review — ${money(pendingSubtotal)} + ${money(gstFor(pendingSubtotal))} GST = ${money(invoiceTotal(pendingSubtotal))}`,
    `• Equipment: ${state.equipment.length} registered · ${state.equipment.filter((item) => item.status === "Available").length} available`,
    `• Missing items: ${gapCount ? `${gapCount} flagged — ask “what's missing before work starts”` : "none"}`,
  ].join("\n");
}

function answerAssistant(message) {
  const query = message.toLowerCase();
  const mentionedJob = assistantMentionedJob(message);
  const mentionedPerson = assistantMentionedPerson(message);
  if (/^(hi|hello|hey)\b/.test(query) || query === "help") {
    return "I can summarize the schedule, brief you on a job or crew member, check safety tickets and contractor WCB clearances, review invoices and equipment, and flag what is missing before field work starts — including FLHA / tailgate sign-offs, safety forms, and daily reports. I can also prepare a task for you to confirm.";
  }
  if (/\b(create|add|assign)\s+(a\s+)?task\b/.test(query)) {
    const match = message.match(/^create task:\s*(.+?)\s*\|\s*job:\s*(.+?)\s*\|\s*assign:\s*(.+)$/i);
    if (!match) {
      return "I can prepare a task for you to confirm. Use this format, replacing the bracketed values:\nCreate task: Verify launcher seals | job: [job name] | assign: [crew member]";
    }
    const [, title, jobQuery, personQuery] = match;
    const jobs = assistantJobMatch(jobQuery);
    const people = assistantPersonMatch(personQuery);
    if (jobs.length !== 1) return jobs.length ? "I found more than one matching job. Use the full job name in your request." : `I couldn't find a job matching “${jobQuery.trim()}”. Check the job name and try again.`;
    if (people.length !== 1) return people.length ? "I found more than one matching team member. Use their full name in your request." : `I couldn't find a team member matching “${personQuery.trim()}”. Check the name and try again.`;
    const taskDraftId = uid();
    assistantTaskDrafts.set(taskDraftId, { title: title.trim(), jobId: jobs[0].id, assignee: people[0].name });
    return `Ready to assign “${title.trim()}” to ${people[0].name} for ${jobs[0].name}, due today. Confirm to add it to the task board.`;
  }
  if (/\b(wcb|clearance|contractor compan(y|ies)|company rates?|rate card)\b/.test(query)) {
    if (!contractorCompaniesCache.length) {
      return state.contractors.length ? `Contractor companies on file:\n${state.contractors.map((company) => `• ${company.name} — ${contractorWcbStatus(company)}`).join("\n")}` : "There are no contractor companies on file yet.";
    }
    return `Contractor companies & WCB clearance:\n${contractorCompaniesCache.map((company) => {
      const rateCount = Object.keys(company.pricing?.laborRates || {}).length + Object.keys(company.pricing?.equipmentRates || {}).length;
      return `• ${company.name} — ${contractorWcbStatus(company)}${rateCount ? ` · ${rateCount} configured rate(s)` : ""}`;
    }).join("\n")}`;
  }
  if (/\b(missing|gaps?|overdue|behind|attention|audit|compliance|readiness|ready to work|not signed|unsigned|sign.?off|signed.?off|flha|tailgate|incomplete)\b/.test(query)) {
    return assistantGapAnswer();
  }
  if (mentionedPerson && /\b(assigned|workload|tasks?|brief|about|status|safety|tickets?|who is)\b/.test(query)) {
    return assistantPersonBriefing(mentionedPerson);
  }
  if (/\b(safety )?tickets?\b|\b(expiring|expires|expired)\b/.test(query)) {
    const tickets = safetyTickets.slice().sort((first, second) => String(first.expires_on).localeCompare(String(second.expires_on)));
    return tickets.length ? `Safety tickets:\n${tickets.map((ticket) => `• ${ticket.title} — ${ticketOwnerName(ticket.user_id)} (${ticketExpiryStatus(ticket)}, expires ${formatDate(ticket.expires_on)})`).join("\n")}` : "There are no safety tickets recorded yet. Add one from the Safety tickets page.";
  }
  if (/\b(schedule|today|runs today|what's happening)\b/.test(query)) {
    const runs = state.runs.filter((run) => run.date === dateOffset(0));
    const tasks = state.tasks.filter((task) => task.due === dateOffset(0) && !task.done);
    const runSummary = runs.length ? runs.map((run) => `• ${run.type} run — ${shortJobName(run.jobId)} (${run.status}, ${run.operator})`).join("\n") : "• No tool runs scheduled today.";
    const taskSummary = tasks.length ? tasks.map((task) => `• ${task.title} — ${task.assignee}`).join("\n") : "• No open tasks due today.";
    return `Today's schedule:\n${runSummary}\n\nOpen tasks:\n${taskSummary}`;
  }
  if (/\b(safety|jsa|dhla|hazard|review forms?|flha|tailgate)\b/.test(query)) {
    const forms = state.safety.filter((form) => form.status !== "Current");
    const coverageGaps = workspaceGapGroups().find((group) => group.key === "coverage");
    const coverageNote = coverageGaps ? `\n\nFLHA / tailgate gaps:\n${coverageGaps.items.slice(0, 5).map((item) => `• ${gapText(item)}`).join("\n")}` : "";
    const formNote = forms.length
      ? `Safety forms needing review:\n${forms.map((form) => `• ${form.title} — ${shortJobName(form.jobId)} (owner: ${form.owner}${form.workDate ? `, for ${formatDate(form.workDate)}` : `, updated ${formatDate(form.updated)}`})`).join("\n")}`
      : "All recorded safety forms are marked current.";
    return `${formNote}${coverageNote}`;
  }
  if (/\b(equipment|tools?|available assets?)\b/.test(query)) {
    const available = state.equipment.filter((item) => item.status === "Available");
    const shown = state.equipment.slice(0, 12);
    const list = shown.length
      ? shown.map((item) => `• ${item.name} (${item.type}, ${item.serial}) — ${item.status}${item.jobId ? ` · ${shortJobName(item.jobId)}` : " · unassigned"}`).join("\n")
      : "No equipment is registered yet.";
    const more = state.equipment.length > shown.length ? `\n• +${state.equipment.length - shown.length} more` : "";
    return `Equipment: ${state.equipment.length} registered · ${available.length} available.\n${list}${more}`;
  }
  if (/\b(invoices?|contractors?|billing|payments?)\b/.test(query)) {
    const pending = state.invoices.filter((invoice) => invoice.status === "Pending");
    const subtotal = pending.reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
    const paid = state.invoices.filter((invoice) => invoice.status !== "Pending");
    const pendingNote = pending.length
      ? `${pending.length} invoice${pending.length === 1 ? "" : "s"} pending review (${money(subtotal)} + ${money(gstFor(subtotal))} Alberta GST = ${money(invoiceTotal(subtotal))}):\n${pending.map((invoice) => `• ${invoiceCompany(invoice)} · ${invoice.number} — ${money(invoice.amount)}, due ${formatDate(invoice.due)} (${shortJobName(invoice.jobId)})`).join("\n")}`
      : "There are no contractor invoices pending review.";
    return `${pendingNote}\n\n${paid.length} invoice${paid.length === 1 ? "" : "s"} already reviewed or paid.`;
  }
  if (/\b(upcoming|this week|next week|tomorrow|calendar)\b/.test(query)) {
    return assistantUpcomingAnswer();
  }
  if (/\b(gps|coordinates?|site plan|site data|legal land|elevation|utm|map features?)\b/.test(query)) {
    if (mentionedJob) return assistantJobBriefing(mentionedJob);
    const mapped = state.jobs.filter((job) => job.siteCoordinate || (job.gpsWorkspace?.features || []).length);
    return mapped.length
      ? `GPS and site data:\n${mapped.map((job) => `• ${job.name} — ${job.siteCoordinate ? `${Number(job.siteCoordinate.lat).toFixed(5)}, ${Number(job.siteCoordinate.lon).toFixed(5)}` : "no site coordinate"} · ${(job.gpsWorkspace?.features || []).length} saved feature(s)`).join("\n")}`
      : "No jobs have saved coordinates or GPS features yet. Create a job with coordinates or open the GPS workspace.";
  }
  if (mentionedJob) {
    return assistantJobBriefing(mentionedJob);
  }
  if (/\b(clients?)\b/.test(query)) {
    return state.clients.length
      ? `Clients:\n${state.clients.map((client) => {
        const clientJobs = state.jobs.filter((job) => job.clientId === client.id || job.client === client.name);
        return `• ${client.name} — ${clientJobs.length} job${clientJobs.length === 1 ? "" : "s"}${clientJobs.length ? ` (${clientJobs.map((job) => `${job.name}: ${job.status || "Scheduled"}`).join("; ")})` : ""}`;
      }).join("\n")}`
      : "There are no clients in the workspace yet.";
  }
  if (/\b(runs?|ili|cleaning|gauging|inspection)\b/.test(query)) {
    const runs = state.runs.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
    const runCounts = state.runs.reduce((totals, run) => { totals[run.type] = (totals[run.type] || 0) + 1; return totals; }, {});
    const counts = Object.entries(runCounts).map(([type, count]) => `${type} ${count}`).join(" · ");
    return runs.length ? `Tool runs — ${state.runs.length} recorded${counts ? ` (${counts})` : ""}:\n${runs.map((run) => `• ${formatDate(run.date)} · ${run.type} — ${shortJobName(run.jobId)} (${run.status}, ${run.tool || "tool not recorded"})`).join("\n")}` : "There are no tool runs recorded yet.";
  }
  if (/\b(tasks?|assignments?|crew|team|people|workload)\b/.test(query)) {
    const openTasks = state.tasks.filter((task) => !task.done);
    const taskNote = openTasks.length
      ? `Open crew tasks:\n${openTasks.map((task) => `• ${task.title} — ${task.assignee}; ${jobNames(task.jobIds)} (due ${formatDate(task.due)})`).join("\n")}`
      : "There are no open tasks in the workspace.";
    const workload = state.people.map((person) => {
      const count = openTasks.filter((task) => task.assignee === person.name).length;
      return `• ${person.name} (${person.role || "crew member"}) — ${count} open task${count === 1 ? "" : "s"}`;
    });
    return `${taskNote}${workload.length ? `\n\nCrew workload:\n${workload.join("\n")}` : ""}`;
  }
  if (/\b(analytics|performance|kpis?|totals?|workspace summary|how are we|dashboard)\b/.test(query)) {
    return assistantWorkspaceSummary();
  }
  if (/\b(jobs?|projects?)\b/.test(query)) {
    return state.jobs.length ? `Jobs in your workspace:\n${state.jobs.map((job) => `• ${job.name} — ${job.status}, ${job.progress}% complete (${job.location})`).join("\n")}` : "There are no jobs in your workspace yet.";
  }
  return "I can answer questions using the shared workspace data. Try asking what's missing before work starts, about a job or crew member, today's schedule, safety forms or tickets, contractor WCB clearances, invoices, equipment, GPS site data, or analytics.";
}

function submitAssistantMessage(rawMessage) {
  const message = rawMessage.trim();
  if (!message) return;
  addAssistantMessage("user", message);
  const existingDrafts = new Set(assistantTaskDrafts.keys());
  const answer = answerAssistant(message);
  const taskDraftId = [...assistantTaskDrafts.keys()].find((id) => !existingDrafts.has(id)) || "";
  addAssistantMessage("assistant", answer, taskDraftId);
  document.getElementById("assistant-input").value = "";
}

function confirmAssistantTask(taskDraftId) {
  const draft = assistantTaskDrafts.get(taskDraftId);
  assistantTaskDrafts.delete(taskDraftId);
  assistantMessages.forEach((message) => {
    if (message.taskDraftId === taskDraftId) message.taskDraftId = "";
  });
  renderAssistantMessages();
  if (!draft || !jobById(draft.jobId) || !state.people.some((person) => person.name === draft.assignee)) {
    addAssistantMessage("assistant", "I couldn't add that task because the job or team member is no longer available. Please check the workspace and try again.");
    return;
  }
  state.tasks.unshift({ id: uid(), title: draft.title, jobIds: [draft.jobId], assignee: draft.assignee, due: dateOffset(0), priority: "Normal", done: false });
  persist();
  renderPage();
  addAssistantMessage("assistant", `Task assigned: “${draft.title}” to ${draft.assignee} for ${shortJobName(draft.jobId)}. It is now on the task board.`);
}

function statusClass(status) {
  if (/expired|rejected|overdue|blocked/i.test(status)) return "status-pill status-red";
  if (/expiring|pending|scheduled|planned|review|required|missing/i.test(status)) return "status-pill status-orange";
  if (/progress|current|valid|approved|complete|available|invoiced|active/i.test(status)) return "status-pill";
  if (/high/i.test(status)) return "status-pill status-red";
  return "status-pill status-gray";
}

function statusPill(status) {
  return `<span class="${statusClass(status)}">${escapeHtml(status)}</span>`;
}

function heading(kicker, title, description, action = "") {
  return `<div class="page-heading"><div><div class="section-kicker">${kicker}</div><h1>${title}</h1><p>${description}</p></div>${action ? `<div class="heading-actions">${action}</div>` : ""}</div>`;
}

function actionButton(label, action, style = "button-primary", icon = "+") {
  return `<button class="button ${style}" data-action="${action}"><span>${icon}</span>${label}</button>`;
}

function applyRoleNavigation(role) {
  const foremanPages = new Set(["foreman", "profile", "safety-library"]);
  document.querySelectorAll(".main-nav .nav-link").forEach((link) => {
    if (link.id === "users-nav-link") {
      link.classList.toggle("hidden", role !== "admin");
      return;
    }
    if (role === "foreman") link.classList.toggle("hidden", !foremanPages.has(link.dataset.page));
    else link.classList.remove("hidden");
  });
  document.querySelectorAll(".main-nav .nav-group").forEach((group) => {
    group.classList.toggle("hidden", role === "foreman" && !group.querySelector(".nav-link:not(.hidden)"));
  });
  document.getElementById("app").classList.toggle("foreman-only", role === "foreman");
}

function setExpandedNavGroup(group, expanded) {
  const toggle = group?.querySelector(".nav-group-toggle");
  const items = group?.querySelector(".nav-group-items");
  if (!toggle || !items) return;
  toggle.setAttribute("aria-expanded", String(expanded));
  items.classList.toggle("hidden", !expanded);
}

function expandNavGroupForPage(page) {
  const activeLink = [...document.querySelectorAll(".main-nav .nav-link")]
    .find((item) => item.dataset.page === page);
  const activeGroup = activeLink?.closest(".nav-group");
  document.querySelectorAll(".main-nav .nav-group").forEach((group) => {
    setExpandedNavGroup(group, group === activeGroup);
  });
}

function setPage(page) {
  if (userProfile?.role === "contractor" && !["contractor-home", "profile", "safety-tickets", "my-workspaces"].includes(page)) page = "contractor-home";
  if (userProfile?.role === "foreman" && !["foreman", "profile", "safety-library", "my-workspaces"].includes(page)) page = "foreman";
  if (page === "users" && userProfile?.role !== "admin") page = "overview";
  activePage = page;
  if (page === "my-workspaces" && personalWorkspaceData.userId !== authSession?.user?.id) {
    personalWorkspaceData = { userId: authSession?.user?.id || "", workspaces: [], modules: [], selectedId: "", editModuleId: "", loaded: false, error: "" };
  }
  document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  expandNavGroupForPage(page);
  if (page === "gps-workspace" && !gpsWorkspaceJobId) gpsWorkspaceJobId = state.jobs[0]?.id || "";
  const names = { overview: "Overview", foreman: "Foreman dashboard", analytics: "Analytics", users: "Admin panel", profile: "My profile", "my-workspaces": "My workspaces", "safety-tickets": "Safety tickets", "contractor-home": "Contractor portal", jobs: "Jobs & calendar", tasks: "Daily tasks", runs: "Tool runs", "tracking-tools": "Tracking Tools", "gps-workspace": "GPS workspace", people: "People & equipment", invoices: "Contractors & invoices", "contractor-work": "Contractor hours & equipment", safety: "Safety & JSA", "safety-library": "Safety library", "safety-fill": "Safety form", reports: "Daily reports" };
  document.getElementById("page-title").textContent = names[page] || "Overview";
  document.getElementById("sidebar").classList.remove("open");
  renderPage();
  if (page === "my-workspaces") void loadPersonalWorkspaces();
  if (page === "users") loadAdminProfiles();
  if (page === "contractor-work") loadAdminContractorWorkflow();
  if (page === "foreman") {
    Promise.allSettled([loadContractorCrewMembers(), loadAdminProfiles()]).then(() => {
      if (activePage === "foreman") renderPage();
    });
  }
  if (page === "safety-library" && userProfile?.role === "foreman") {
    void refreshForemanWorkspace();
  }
}

function renderPage() {
  if (gpsWorkspaceUnmount) {
    const unmount = gpsWorkspaceUnmount;
    gpsWorkspaceUnmount = null;
    unmount();
  }
  if (userProfile?.role === "contractor") {
    const contractorPages = { "contractor-home": renderContractorPortal, profile: renderMyProfile, "safety-tickets": renderSafetyTickets, "my-workspaces": renderPersonalWorkspaces };
    document.getElementById("page-content").innerHTML = (contractorPages[activePage] || renderContractorPortal)();
    document.getElementById("page-title").textContent = activePage === "profile" ? "My profile" : activePage === "safety-tickets" ? "Safety tickets" : activePage === "my-workspaces" ? "My workspaces" : "Contractor portal";
    if (activePage === "profile" || activePage === "safety-tickets") hydratePrivatePhotos();
    return;
  }
  const pages = { overview: renderOverview, foreman: renderForemanDashboard, analytics: renderAnalytics, users: renderUsers, profile: renderMyProfile, "my-workspaces": renderPersonalWorkspaces, "safety-tickets": renderSafetyTickets, jobs: renderJobs, tasks: renderTasks, runs: renderRuns, "tracking-tools": renderTrackingTools, "gps-workspace": renderGpsWorkspace, people: renderPeople, invoices: renderInvoices, "contractor-work": renderContractorWork, safety: renderSafety, "safety-library": renderSafetyLibrary, "safety-fill": renderSafetyFill, reports: renderReports };
  pageContent.innerHTML = (pages[activePage] || renderOverview)();
  document.body.classList.toggle("safety-fill-active", activePage === "safety-fill");
  if (activePage === "safety-fill") mountSafetySignaturePad();
  if (activePage === "gps-workspace") {
    const job = jobById(gpsWorkspaceJobId);
    if (job) {
      gpsWorkspaceUnmount = window.GPSWorkspace.mount(
        document.getElementById("gps-workspace-root"),
        job,
        (gpsWorkspace) => {
          job.gpsWorkspace = gpsWorkspace;
          persist();
        },
        () => showToast("GPS workspace saved to this job."),
      );
    }
  }
  document.getElementById("task-nav-count").textContent = state.tasks.filter((task) => !task.done).length || "";
  if (activePage === "profile" || activePage === "safety-tickets") hydratePrivatePhotos();
}

const WORKSPACE_PAGES = [
  ["overview", "Overview"], ["foreman", "Foreman dashboard"], ["jobs", "Jobs & calendar"],
  ["tasks", "Daily tasks"], ["runs", "Tool runs"], ["tracking-tools", "Tracking Tools"],
  ["gps-workspace", "GPS workspace"], ["people", "People & equipment"],
  ["invoices", "Invoices"], ["contractor-work", "Hours & equipment"],
  ["safety", "Safety & JSA"], ["safety-library", "Safety library"],
  ["safety-tickets", "Safety tickets"], ["reports", "Daily reports"],
  ["analytics", "Analytics"], ["profile", "My profile"], ["users", "Admin panel"],
  ["contractor-home", "Contractor portal"],
];

function availableWorkspacePages() {
  const role = userProfile?.role;
  return WORKSPACE_PAGES.filter(([id]) => {
    if (role === "contractor") return ["contractor-home", "profile", "safety-tickets"].includes(id);
    if (role === "foreman") return ["foreman", "profile", "safety-library"].includes(id);
    if (role !== "admin" && role !== "manager") return false;
    return id !== "contractor-home" && (id !== "users" || role === "admin");
  });
}

async function loadPersonalWorkspaces() {
  const userId = authSession?.user?.id;
  if (!supabaseClient || !userId) return;
  const request = ++personalWorkspaceRequest;
  try {
    const [workspaces, modules] = await Promise.all([
      supabaseClient.from("personal_workspaces").select("id,name,pages,module_ids").eq("user_id", userId).order("created_at"),
      supabaseClient.from("shared_workspace_modules").select("id,name,description,pages,created_by").order("created_at"),
    ]);
    if (workspaces.error || modules.error) throw workspaces.error || modules.error;
    if (request !== personalWorkspaceRequest || authSession?.user?.id !== userId) return;
    personalWorkspaceData.userId = userId;
    personalWorkspaceData.workspaces = workspaces.data || [];
    personalWorkspaceData.modules = modules.data || [];
    personalWorkspaceData.loaded = true;
    personalWorkspaceData.error = "";
    if (personalWorkspaceData.selectedId && !personalWorkspaceData.workspaces.some((item) => item.id === personalWorkspaceData.selectedId)) personalWorkspaceData.selectedId = "";
    if (activePage === "my-workspaces") renderPage();
  } catch (error) {
    if (request !== personalWorkspaceRequest || authSession?.user?.id !== userId) return;
    console.error("Could not load modular workspaces.", error);
    personalWorkspaceData.loaded = false;
    personalWorkspaceData.error = "Could not load workspaces. Check your connection and apply the modular workspace SQL migration.";
    if (activePage === "my-workspaces") renderPage();
  }
}

function renderPersonalWorkspaces() {
  const header = heading("PERSONAL DASHBOARD", "My workspaces", "Create personal layouts and shared shortcut modules for your work. Existing page permissions still apply.", userProfile?.role === "contractor" ? `<button type="button" class="button button-outline" data-page="contractor-home">Back to contractor portal</button>` : "");
  if (!personalWorkspaceData.loaded) return `${header}<section class="card panel"><div class="empty-state"><strong>${personalWorkspaceData.error ? "Workspaces unavailable" : "Loading workspaces"}</strong>${escapeHtml(personalWorkspaceData.error || "Loading your layouts and shared modules.")}</div>${personalWorkspaceData.error ? `<button type="button" class="button button-outline" data-workspace-reload>Retry</button>` : ""}</section>`;
  const availablePages = availableWorkspacePages();
  const allowed = new Set(availablePages.map(([id]) => id));
  const selected = personalWorkspaceData.workspaces.find((item) => item.id === personalWorkspaceData.selectedId);
  const selectedPages = selected?.pages || [];
  const selectedModules = selected?.module_ids || [];
  const moduleBeingEdited = personalWorkspaceData.modules.find((item) => item.id === personalWorkspaceData.editModuleId);
  const pageChoices = (name, checked) => availablePages.map(([id, label]) => `<label class="workspace-choice"><input type="checkbox" name="${name}" value="${escapeHtml(id)}" ${checked.includes(id) ? "checked" : ""}><span>${escapeHtml(label)}</span></label>`).join("");
  const workspaceOptions = personalWorkspaceData.workspaces.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected?.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
  const shortcutCards = selected
    ? [...availablePages.filter(([id]) => selectedPages.includes(id)).map(([id, label]) => `<article class="card workspace-shortcut"><strong>${escapeHtml(label)}</strong><button type="button" class="button button-outline" data-page="${escapeHtml(id)}">Open</button></article>`),
      ...personalWorkspaceData.modules.filter((item) => selectedModules.includes(item.id)).map((item) => {
        const links = availablePages.filter(([id]) => (item.pages || []).includes(id));
        return `<article class="card workspace-shortcut"><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.description || "Shared module")}</p>${links.length ? `<div class="workspace-shortcut-links">${links.map(([id, label]) => `<button type="button" class="button button-outline" data-page="${escapeHtml(id)}">${escapeHtml(label)}</button>`).join("")}</div>` : `<p>No links available for your role.</p>`}</article>`;
      })].join("")
    : "";
  const moduleChoices = personalWorkspaceData.modules.map((item) => `<label class="workspace-choice"><input type="checkbox" name="moduleIds" value="${escapeHtml(item.id)}" ${selectedModules.includes(item.id) ? "checked" : ""}><span>${escapeHtml(item.name)}</span></label>`).join("");
  const moduleList = personalWorkspaceData.modules.map((item) => `<div class="workspace-module-row"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.description || "Shared shortcut module")} · ${(item.pages || []).filter((id) => allowed.has(id)).length} accessible link(s)</span></div>${item.created_by === authSession?.user?.id || userProfile?.role === "admin" ? `<div><button type="button" class="text-link" data-workspace-module-edit="${escapeHtml(item.id)}">Edit</button> <button type="button" class="text-link foreman-danger-link" data-workspace-module-delete="${escapeHtml(item.id)}">Delete</button></div>` : ""}</div>`).join("");
  return `${header}
    <section class="card panel workspace-panel"><div class="panel-head"><div><h2 class="panel-title">Your layouts</h2><p class="panel-subtitle">Layouts are private to your account. Choose a saved layout or create a new one.</p></div><button type="button" class="button button-outline" data-workspace-new>New workspace</button></div>
      <label class="workspace-field">Workspace<select class="form-input" id="personal-workspace-select"><option value="">New workspace</option>${workspaceOptions}</select></label>
      ${selected ? `<div class="workspace-shortcut-grid">${shortcutCards || `<div class="empty-state">No shortcuts selected yet.</div>`}</div>` : ""}
      <form id="personal-workspace-form" data-workspace-id="${escapeHtml(selected?.id || "")}" class="workspace-editor">
        <label class="workspace-field">Workspace name<input class="form-input" name="name" maxlength="80" required value="${escapeHtml(selected?.name || "")}" placeholder="e.g. Tracking digs"></label>
        <strong>Existing Fieldwork pages</strong><div class="workspace-choice-grid">${pageChoices("pages", selectedPages)}</div>
        <strong>Shared custom modules</strong><div class="workspace-choice-grid">${moduleChoices || `<span class="form-hint">No custom modules yet. Create one below.</span>`}</div>
        <div class="workspace-actions"><button type="submit" class="button button-primary">${selected ? "Save workspace" : "Create workspace"}</button>${selected ? `<button type="button" class="text-link foreman-danger-link" data-workspace-delete="${escapeHtml(selected.id)}">Delete workspace</button>` : ""}</div>
      </form></section>
    <section class="card panel workspace-panel"><div class="panel-head"><div><h2 class="panel-title">Shared custom modules</h2><p class="panel-subtitle">All approved users can see these modules. Their links only open pages allowed by each user's role.</p></div></div>
      <div class="workspace-module-list">${moduleList || `<p class="form-hint">No shared modules yet.</p>`}</div>
      <form id="shared-module-form" data-module-id="${escapeHtml(moduleBeingEdited?.id || "")}" class="workspace-editor">
        <strong>${moduleBeingEdited ? "Edit shared module" : "Create a shared module"}</strong>
        <label class="workspace-field">Module name<input class="form-input" name="name" maxlength="80" required value="${escapeHtml(moduleBeingEdited?.name || "")}" placeholder="e.g. ILI support"></label>
        <label class="workspace-field">Description (optional)<input class="form-input" name="description" maxlength="240" value="${escapeHtml(moduleBeingEdited?.description || "")}"></label>
        <strong>Pages to include</strong><div class="workspace-choice-grid">${pageChoices("pages", moduleBeingEdited?.pages || [])}</div>
        <div class="workspace-actions"><button type="submit" class="button button-primary">${moduleBeingEdited ? "Save module" : "Create shared module"}</button>${moduleBeingEdited ? `<button type="button" class="button button-outline" data-workspace-module-cancel>Cancel</button>` : ""}</div>
      </form></section>`;
}

async function savePersonalWorkspace(form) {
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  if (!name) { showToast("Enter a workspace name."); return; }
  const id = form.dataset.workspaceId;
  const previous = personalWorkspaceData.workspaces.find((item) => item.id === id);
  if (id && !previous) { showToast("That workspace is no longer available."); return; }
  const allowed = new Set(availableWorkspacePages().map(([page]) => page));
  const pages = [...new Set([...data.getAll("pages").filter((page) => allowed.has(page)), ...(previous?.pages || []).filter((page) => !allowed.has(page))])];
  const moduleIds = [...new Set(data.getAll("moduleIds").filter((moduleId) => personalWorkspaceData.modules.some((item) => item.id === moduleId)))];
  const payload = { name, pages, module_ids: moduleIds };
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const query = id
      ? supabaseClient.from("personal_workspaces").update(payload).eq("id", id).eq("user_id", authSession.user.id)
      : supabaseClient.from("personal_workspaces").insert({ ...payload, user_id: authSession.user.id });
    const { data: saved, error } = await query.select("id").single();
    if (error) throw error;
    personalWorkspaceData.selectedId = saved.id;
    await loadPersonalWorkspaces();
    showToast("Workspace saved.");
  } catch (error) {
    console.error("Could not save personal workspace.", error);
    showToast("Could not save this workspace. Check your connection and try again.");
  } finally { button.disabled = false; }
}

async function saveSharedWorkspaceModule(form) {
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const id = form.dataset.moduleId;
  const previous = personalWorkspaceData.modules.find((item) => item.id === id);
  if (!name) { showToast("Enter a module name."); return; }
  if (id && (!previous || (previous.created_by !== authSession?.user?.id && userProfile?.role !== "admin"))) { showToast("You cannot edit this module."); return; }
  const allowed = new Set(availableWorkspacePages().map(([page]) => page));
  const pages = [...new Set([...data.getAll("pages").filter((page) => allowed.has(page)), ...(previous?.pages || []).filter((page) => !allowed.has(page))])];
  if (!pages.length) { showToast("Choose at least one page for the module."); return; }
  const payload = { name, description: String(data.get("description") || "").trim(), pages };
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const query = id
      ? supabaseClient.from("shared_workspace_modules").update(payload).eq("id", id)
      : supabaseClient.from("shared_workspace_modules").insert({ ...payload, created_by: authSession.user.id });
    const { error } = await query.select("id").single();
    if (error) throw error;
    personalWorkspaceData.editModuleId = "";
    await loadPersonalWorkspaces();
    showToast("Shared module saved.");
  } catch (error) {
    console.error("Could not save shared workspace module.", error);
    showToast("Could not save this module. Check your connection and try again.");
  } finally { button.disabled = false; }
}

async function deletePersonalWorkspaceItem(table, id) {
  const isModule = table === "shared_workspace_modules";
  const item = (isModule ? personalWorkspaceData.modules : personalWorkspaceData.workspaces).find((entry) => entry.id === id);
  if (!item) { showToast("That item is no longer available."); return; }
  if (isModule && item.created_by !== authSession?.user?.id && userProfile?.role !== "admin") { showToast("Only its creator or an admin can delete this module."); return; }
  if (!confirm(isModule ? `Delete the shared module “${item.name}” for everyone?` : `Delete your workspace “${item.name}”?`)) return;
  try {
    const { data, error } = await supabaseClient.from(table).delete().eq("id", id).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("The item could not be deleted or is no longer available.");
    if (isModule && personalWorkspaceData.editModuleId === id) personalWorkspaceData.editModuleId = "";
    if (!isModule && personalWorkspaceData.selectedId === id) personalWorkspaceData.selectedId = "";
    await loadPersonalWorkspaces();
    showToast(isModule ? "Shared module deleted." : "Workspace deleted.");
  } catch (error) {
    console.error("Could not delete workspace item.", error);
    showToast("Could not delete this item. Check your access and try again.");
  }
}

function renderOverview() {
  const activeJobs = state.jobs.filter((job) => /progress/i.test(job.status)).length;
  const openTasks = state.tasks.filter((task) => !task.done).length;
  const availableEquipment = state.equipment.filter((item) => item.status === "Available").length;
  const pendingInvoices = state.invoices.filter((invoice) => invoice.status === "Pending").length;
  const todayRuns = state.runs.filter((run) => run.date === dateOffset(0)).length;
  const todaysTasks = state.tasks.filter((task) => task.due === dateOffset(0)).slice(0, 4);
  const upcoming = state.runs.filter((run) => run.date >= dateOffset(0)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  const activity = [
    { icon: "✓", text: `<strong>${state.safety.filter((item) => item.updated === dateOffset(0)).length} safety forms</strong> updated today`, time: "Today" },
    { icon: "◎", text: `<strong>${todayRuns} tool run${todayRuns === 1 ? "" : "s"}</strong> on the schedule`, time: "Field operations" },
    { icon: "▤", text: `<strong>${pendingInvoices} invoice${pendingInvoices === 1 ? "" : "s"}</strong> waiting for review`, time: "Contractors" },
  ];
  return `${heading(today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }).toUpperCase(), `Good ${today.getHours() < 12 ? "morning" : today.getHours() < 17 ? "afternoon" : "evening"}, ${escapeHtml(state.user.split(" ")[0] || "there")}.`, "Here's what's happening across your field operations today.", actionButton("New task", "new-task", "button-lime"))}
    <div class="metric-grid">
      <article class="card metric-card"><div class="metric-top">Active jobs <span class="metric-icon">▦</span></div><div class="metric-value">${activeJobs.toString().padStart(2, "0")}</div><div class="metric-note"><span class="positive">●</span> ${state.jobs.length} jobs in your workspace</div></article>
      <article class="card metric-card"><div class="metric-top">Open tasks <span class="metric-icon">☷</span></div><div class="metric-value">${openTasks.toString().padStart(2, "0")}</div><div class="metric-note">${state.tasks.filter((task) => task.due === dateOffset(0) && !task.done).length} due today</div></article>
      <article class="card metric-card"><div class="metric-top">Runs today <span class="metric-icon">◎</span></div><div class="metric-value">${todayRuns.toString().padStart(2, "0")}</div><div class="metric-note">${state.runs.filter((run) => run.date >= dateOffset(0)).length} planned or active</div></article>
      <article class="card metric-card"><div class="metric-top">Equipment available <span class="metric-icon">⌁</span></div><div class="metric-value">${availableEquipment.toString().padStart(2, "0")}</div><div class="metric-note">${pendingInvoices} invoice${pendingInvoices === 1 ? "" : "s"} need review</div></article>
    </div>
    <div class="dashboard-grid">
      <section class="card panel"><div class="panel-head"><div><h2 class="panel-title">Today's field schedule</h2><p class="panel-subtitle">Tool runs and key activities</p></div><button class="text-link" data-page="jobs">View calendar →</button></div>
        ${upcoming.length ? upcoming.map((run) => `<div class="schedule-row"><div class="schedule-time">${run.date === dateOffset(0) ? "Today" : formatDate(run.date)}</div><div class="schedule-main"><strong>${escapeHtml(run.type)} run · ${escapeHtml(run.tool)}</strong><span>${escapeHtml(shortJobName(run.jobId))} · ${escapeHtml(run.operator)}</span></div>${statusPill(run.status)}</div>`).join("") : `<div class="empty-state"><strong>No runs on the calendar</strong>Add a tool run to start tracking field activity.</div>`}
      </section>
      <section class="card panel"><div class="panel-head"><div><h2 class="panel-title">Team pulse</h2><p class="panel-subtitle">A quick look at today's workload</p></div><span class="metric-icon">↗</span></div>
        ${activity.map((item) => `<div class="activity-item"><span class="activity-dot">${item.icon}</span><div class="activity-text">${item.text}<small>${item.time}</small></div></div>`).join("")}
        <div class="panel-head" style="margin:15px 0 8px"><div><h2 class="panel-title">Your tasks</h2></div><button class="text-link" data-page="tasks">See all →</button></div>
        ${todaysTasks.length ? todaysTasks.map((task) => `<div class="activity-item"><span class="activity-dot">${task.done ? "✓" : "·"}</span><div class="activity-text">${escapeHtml(task.title)}<small>${escapeHtml(shortJobName(task.jobIds[0]))} · ${escapeHtml(task.assignee)}</small></div></div>`).join("") : `<div class="empty-state">No tasks due today.</div>`}
      </section>
    </div>
    <section class="card panel" style="margin-top:15px"><div class="panel-head"><div><h2 class="panel-title">Active jobs</h2><p class="panel-subtitle">Progress across current field work</p></div><button class="text-link" data-page="jobs">All jobs →</button></div>
      <div class="job-list">${state.jobs.slice(0, 3).map((job) => `<div class="job-card"><div class="job-symbol">⌖</div><div class="job-info"><strong>${escapeHtml(job.name)}</strong><p>${escapeHtml(job.client)} · ${escapeHtml(job.location)}</p></div><div class="job-meta">${formatDate(job.date)}</div><div class="job-right">${statusPill(job.status)}${renderJobSafetySummary(job)}<div class="progress-wrap"><div class="progress-label"><span>Progress</span><span>${job.progress}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, Math.max(0, Number(job.progress) || 0))}%"></div></div></div></div></div>`).join("") || `<div class="empty-state"><strong>No jobs yet</strong>Add a job to organize your field work.</div>`}</div>
    </section>`;
}

function foremanName() {
  return String(userProfile?.full_name || state.user || "").trim();
}

function foremanReadOnly() {
  return userProfile?.role === "foreman";
}

function jobForemanName(job) {
  if (Object.prototype.hasOwnProperty.call(job, "foremanUserId")) {
    return job.foremanUserId ? String(job.foremanName || job.crewLead || "").trim() : "";
  }
  return String(job.crewLead || "").trim();
}

function jobForemanIsMe(job) {
  if (userProfile?.role === "foreman") return job.foremanUserId === userProfile.id;
  if (Object.prototype.hasOwnProperty.call(job, "foremanUserId")) return job.foremanUserId === userProfile?.id;
  const name = foremanName().toLowerCase();
  return Boolean(name) && String(job.crewLead || "").trim().toLowerCase() === name;
}

function foremanVisibleJobs() {
  if (userProfile?.role === "foreman") return state.jobs.filter((job) => job.foremanUserId === userProfile.id);
  const myJobs = state.jobs.filter((job) => jobForemanIsMe(job));
  const canPreview = ["admin", "manager"].includes(userProfile?.role || "");
  if (!canPreview) return myJobs;
  return [...myJobs, ...state.jobs.filter((job) => !myJobs.includes(job))];
}

function currentForemanJob() {
  const jobs = foremanVisibleJobs();
  const selected = jobs.find((job) => job.id === foremanJobId) || jobs.find((job) => jobForemanIsMe(job)) || jobs[0];
  foremanJobId = selected?.id || "";
  return selected || null;
}

function foremanCompanyName(companyId) {
  if (!companyId) return "";
  return jobAssignmentCompanies().find((company) => company.id === companyId)?.name || "";
}

function foremanJobCrew(job) {
  const people = new Map();
  const add = (name, role, companyId) => {
    const normalized = String(name || "").trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (!people.has(key)) {
      const resolvedCompanyId = companyId || job.companyId || "";
      people.set(key, {
        name: normalized,
        role: role || "Crew member",
        companyId: resolvedCompanyId,
        companyName: foremanCompanyName(resolvedCompanyId) || job.companyName || "",
      });
    }
  };
  add(jobForemanName(job), "Foreman", job.companyId);
  (job.crewMembers || []).forEach((name) => add(name, "Crew member", job.companyId));
  state.people
    .filter((person) => (person.jobIds || []).includes(job.id))
    .filter((person) => !person.companyId || person.companyId === job.companyId || person.companyId === INTERNAL_TEAM_COMPANY_ID)
    .forEach((person) => add(person.name, person.role, person.companyId));
  return [...people.values()].sort((first, second) => first.name.localeCompare(second.name));
}

function foremanJobContractors(job) {
  const people = new Map();
  const assignedCompanyIds = new Set(adminContractorAssignments
    .filter((row) => row.job_id === job.id)
    .map((row) => row.company_id));
  const add = (name, companyId, companyName) => {
    const normalized = String(name || "").trim();
    if (!normalized || !companyId || companyId === job.companyId || companyId === INTERNAL_TEAM_COMPANY_ID) return;
    const key = `${companyId}:${normalized.toLowerCase()}`;
    if (!people.has(key)) {
      people.set(key, { name: normalized, companyId, companyName: companyName || foremanCompanyName(companyId) || "Contractor" });
    }
  };
  state.people.forEach((person) => {
    const companyId = person.companyId || "";
    if (!companyId || companyId === INTERNAL_TEAM_COMPANY_ID || companyId === job.companyId) return;
    if (assignedCompanyIds.has(companyId) || (person.jobIds || []).includes(job.id)) {
      add(person.name, companyId, foremanCompanyName(companyId));
    }
  });
  contractorCrewMembersCache.forEach((member) => {
    if (assignedCompanyIds.has(member.company_id)) add(member.full_name || member.email, member.company_id, member.company_name);
  });
  return [...people.values()].sort((first, second) => first.companyName.localeCompare(second.companyName) || first.name.localeCompare(second.name));
}

function foremanTimesheets(jobId) {
  return (state.timesheets || []).filter((entry) => entry.jobId === jobId);
}

function hoursLabel(value) {
  return `${roundCurrency(value)} h`;
}

function timesheetTotals(entries) {
  const today = dateOffset(0);
  const weekStart = dateOffset(-6);
  const totalFor = (list) => list.reduce((sum, entry) => sum + Number(entry.hours || 0) + Number(entry.overtimeHours || 0), 0);
  return {
    today: totalFor(entries.filter((entry) => entry.date === today)),
    week: totalFor(entries.filter((entry) => entry.date >= weekStart && entry.date <= today)),
  };
}

function timesheetSummaryTable(entries) {
  const people = new Map();
  entries.forEach((entry) => {
    const key = `${entry.companyId || ""}:${entry.personName}`;
    if (!people.has(key)) people.set(key, { name: entry.personName, companyName: entry.companyName || "", hours: 0, overtime: 0 });
    const person = people.get(key);
    person.hours += Number(entry.hours || 0);
    person.overtime += Number(entry.overtimeHours || 0);
  });
  return [...people.values()].sort((first, second) => first.name.localeCompare(second.name));
}

function renderTimesheetRows(entries, emptyText, canEdit = true) {
  const sorted = entries.slice().sort((first, second) => String(second.date).localeCompare(String(first.date)) || String(first.personName).localeCompare(String(second.personName)));
  if (!sorted.length) return `<div class="empty-state"><strong>No time recorded yet</strong>${emptyText}</div>`;
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Person</th><th>Regular</th><th>Overtime</th><th>Notes</th>${canEdit ? "<th></th>" : ""}</tr></thead><tbody>${sorted.slice(0, 15).map((entry) => `<tr><td>${formatDate(entry.date)}</td><td>${escapeHtml(entry.personName)}${entry.companyName ? `<span class="table-secondary">${escapeHtml(entry.companyName)}</span>` : ""}</td><td>${hoursLabel(entry.hours)}</td><td>${hoursLabel(entry.overtimeHours)}</td><td>${escapeHtml(entry.notes || "—")}</td>${canEdit ? `<td class="foreman-row-actions"><button class="text-link" data-timesheet="${escapeHtml(entry.id)}">Edit</button><button class="text-link foreman-danger-link" data-delete-timesheet="${escapeHtml(entry.id)}">Delete</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

function foremanSafetyState(job) {
  const today = dateOffset(0);
  const jobForms = state.safety.filter((form) => form.jobId === job.id);
  const jobAnalysis = jobForms.find((form) => !DAILY_SAFETY_PATTERN.test(form.title || "") && /(jsa|job safety analysis)/i.test(form.title || "")) || null;
  const dailyForms = jobForms.filter((form) => DAILY_SAFETY_PATTERN.test(form.title || "") && form.workDate === today);
  const daily = dailyForms.find((form) => form.status === "Current") || dailyForms[0] || null;
  return { jobForms, jobAnalysis, daily, openForms: jobForms.filter((form) => form.status !== "Current") };
}

function foremanRequirementRow(label, form, job, fallbackDetail) {
  const detail = form
    ? `${escapeHtml(form.owner || "Crew")} · ${form.workDate ? formatDate(form.workDate) : `updated ${formatDate(form.updated)}`}`
    : fallbackDetail;
  const action = foremanReadOnly()
    ? ""
    : form
      ? `<button class="text-link" data-safety-form="${escapeHtml(form.id)}">${form.status === "Current" ? "View" : "Complete"}</button>`
      : `<button class="text-link" data-action="new-safety" data-job-id="${escapeHtml(job.id)}">Add report</button>`;
  return `<li class="foreman-check"><div><strong>${label}</strong><span>${detail}</span></div>${form ? statusPill(form.status) : statusPill("Missing")}${action}</li>`;
}

function renderForemanDashboard() {
  const jobs = foremanVisibleJobs();
  const job = currentForemanJob();
  if (!job) {
    const emptyMessage = foremanReadOnly()
      ? "No jobs are assigned to your foreman account yet. Ask a workspace admin to assign you to a job."
      : "Assign a foreman account to a job to give them access to its job-scoped dashboard.";
    return `${heading("FOREMAN WORKSPACE", "Foreman dashboard", "Jobs assigned to you as foreman, with safety, tasks, and timesheets in one place.", foremanReadOnly() ? `<button class="button button-outline" data-action="refresh-foreman-dashboard">Refresh</button>` : "")}
      <section class="card panel"><div class="empty-state"><strong>No foreman jobs assigned</strong>${emptyMessage}</div></section>`;
  }
  const isMine = jobForemanIsMe(job);
  const crew = foremanJobCrew(job);
  const contractors = foremanJobContractors(job);
  const entries = foremanTimesheets(job.id);
  const crewEntries = entries.filter((entry) => entry.kind !== "contractor");
  const contractorEntries = entries.filter((entry) => entry.kind === "contractor");
  const crewTotals = timesheetTotals(crewEntries);
  const contractorTotals = timesheetTotals(contractorEntries);
  const safety = foremanSafetyState(job);
  const jobTasks = state.tasks.filter((task) => (task.jobIds || []).includes(job.id));
  const openTasks = jobTasks.filter((task) => !task.done).sort((first, second) => String(first.due).localeCompare(String(second.due)));
  const todayTasks = openTasks.filter((task) => task.due <= dateOffset(0));
  const progress = Math.min(100, Math.max(0, Number(job.progress) || 0));
  const jobPicker = jobs.length > 1
    ? `<label class="foreman-job-picker"><span>Viewing job</span><select id="foreman-job-select" class="form-input">${jobs.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === job.id ? "selected" : ""}>${escapeHtml(item.name)}${jobForemanIsMe(item) ? "" : " (preview)"}</option>`).join("")}</select></label>`
    : "";
  const crewPeopleTotals = timesheetSummaryTable(crewEntries.filter((entry) => entry.date >= dateOffset(-6)));
  const contractorPeopleTotals = timesheetSummaryTable(contractorEntries.filter((entry) => entry.date >= dateOffset(-6)));
  const peopleTotalsMarkup = (totals, label) => totals.length
    ? `<div class="foreman-person-totals"><strong>${label}</strong>${totals.map((person) => `<span>${escapeHtml(person.name)} <b>${hoursLabel(person.hours + person.overtime)}</b></span>`).join("")}</div>`
    : "";
  const safetyReports = safety.jobForms
    .slice()
    .sort((first, second) => String(second.workDate || second.updated).localeCompare(String(first.workDate || first.updated)));
  const assignedSafetyDocuments = (state.safetyLibrary || []).filter((item) => item.jobId === job.id);
  const crewTickets = foremanReadOnly() ? [] : safetyTickets.filter((ticket) => {
    const holder = String(ticket.holder_name || ticketOwnerName(ticket.user_id) || "").toLowerCase();
    return ticketExpiryStatus(ticket) !== "Current" && crew.some((person) => person.name.toLowerCase() === holder);
  });
  const fillableTemplates = safetyTemplatesForJob(job.id);
  const headerActions = foremanReadOnly()
    ? `<button class="button button-outline" data-action="refresh-foreman-dashboard">Refresh</button>`
    : `<button class="button button-outline" data-action="new-safety" data-job-id="${escapeHtml(job.id)}"><span>◇</span>New safety report</button><button class="button button-primary" data-action="crew-time" data-job-id="${escapeHtml(job.id)}"><span>◷</span>Add crew time</button>`;
  return `${heading("FOREMAN WORKSPACE", "Foreman dashboard", `Supervise ${escapeHtml(job.name)} — safety, tasks, crew time, and contractor time in one place.`, headerActions)}
    <section class="card panel foreman-job-card">
      <div class="panel-head">
        <div><div class="section-kicker">ASSIGNED JOB</div><h2 class="panel-title">${escapeHtml(job.name)}</h2><p class="panel-subtitle">${escapeHtml(job.client || "No client")} · ${escapeHtml(job.location || "No location")} · ${formatDate(job.startDate || job.date)} – ${formatDate(job.endDate || job.date)}</p></div>
        <div class="foreman-job-side">${statusPill(job.status || "Scheduled")}${jobPicker}</div>
      </div>
      <div class="foreman-job-stats">
        <div class="foreman-job-stat"><span>Foreman</span><strong>${escapeHtml(jobForemanName(job) || "Unassigned")}</strong><small>${isMine ? "You are in charge of this job" : "Admin preview — you are not the listed foreman"}</small></div>
        <div class="foreman-job-stat"><span>On site</span><strong>${crew.length} crew · ${contractors.length} contractor</strong><small>${escapeHtml(job.companyName || "Company not set")}</small></div>
        <div class="foreman-job-stat"><span>Hours today</span><strong>${hoursLabel(crewTotals.today + contractorTotals.today)}</strong><small>${hoursLabel(crewTotals.week + contractorTotals.week)} this week</small></div>
        <div class="foreman-job-stat"><span>Progress</span><strong>${progress}%</strong><div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div></div>
      </div>
      <div class="foreman-crew-chips">${crew.map((person) => `<span class="foreman-chip">${escapeHtml(person.name)}<small>${escapeHtml(person.role)}</small></span>`).join("") || `<span class="foreman-chip">No crew assigned</span>`}</div>
    </section>
    <div class="foreman-grid">
      <section class="card panel">
        <div class="panel-head"><div><h2 class="panel-title">Safety required</h2><p class="panel-subtitle">Job JSA and today's FLHA / tailgate sign-off</p></div>${foremanReadOnly() ? "" : `<button class="text-link" data-action="new-safety" data-job-id="${escapeHtml(job.id)}">New report</button>`}</div>
        <ul class="foreman-check-list">
          ${foremanRequirementRow("Job Safety Analysis (JSA)", safety.jobAnalysis, job, "No job-level JSA recorded yet")}
          ${foremanRequirementRow("Today's FLHA / tailgate", safety.daily, job, "No FLHA or tailgate record for today")}
        </ul>
        ${crewTickets.length ? `<div class="foreman-ticket-block"><strong>Crew tickets needing attention</strong>${crewTickets.map((ticket) => `<div class="foreman-ticket-row"><span>${escapeHtml(ticket.title)} · ${escapeHtml(ticket.holder_name || ticketOwnerName(ticket.user_id))}</span>${statusPill(ticketExpiryStatus(ticket))}</div>`).join("")}</div>` : ""}
        ${!foremanReadOnly() && fillableTemplates.length ? `<div class="foreman-form-templates"><strong>Fill a safety form</strong>${fillableTemplates.map((template) => `<button class="button button-outline" data-fill-template="${escapeHtml(template.id)}" data-job-id="${escapeHtml(job.id)}">${escapeHtml(template.name)}</button>`).join("")}</div>` : ""}
        <p class="foreman-note">${!safety.jobForms.length ? "No safety reports recorded for this job yet." : safety.openForms.length ? `${safety.openForms.length} safety report${safety.openForms.length === 1 ? "" : "s"} still open for this job.` : "All safety reports for this job are current."}</p>
      </section>
      <section class="card panel">
        <div class="panel-head"><div><h2 class="panel-title">Tasks</h2><p class="panel-subtitle">Today and overdue work for this job</p></div>${foremanReadOnly() ? "" : `<button class="text-link" data-action="foreman-task" data-job-id="${escapeHtml(job.id)}">Assign task</button>`}</div>
        ${todayTasks.length ? `<div class="foreman-task-list">${todayTasks.map((task) => `<div class="task-row"><input class="task-check" type="checkbox" data-task="${escapeHtml(task.id)}" ${task.done ? "checked" : ""} ${foremanReadOnly() ? "disabled" : ""} aria-label="Mark ${escapeHtml(task.title)} complete"><div class="task-name"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.assignee)} · due ${formatDate(task.due)}${task.due < dateOffset(0) ? " · overdue" : ""}</span></div>${statusPill(task.due < dateOffset(0) ? "Overdue" : task.priority === "High" ? "High priority" : "Open")}</div>`).join("")}</div>` : `<div class="empty-state"><strong>No tasks for today</strong>${foremanReadOnly() ? "No tasks are scheduled for this job today." : "Assign a task to keep the crew moving."}</div>`}
        ${openTasks.length > todayTasks.length ? `<p class="foreman-note">${openTasks.length - todayTasks.length} more open task${openTasks.length - todayTasks.length === 1 ? "" : "s"} scheduled for later.</p>` : ""}
      </section>
      <section class="card panel">
        <div class="panel-head"><div><h2 class="panel-title">Crew timesheets</h2><p class="panel-subtitle">Regular and overtime hours for this job</p></div>${foremanReadOnly() ? "" : `<button class="text-link" data-action="crew-time" data-job-id="${escapeHtml(job.id)}">Add time</button>`}</div>
        <div class="foreman-time-summary"><span><strong>${hoursLabel(crewTotals.today)}</strong> today</span><span><strong>${hoursLabel(crewTotals.week)}</strong> this week</span><span><strong>${crew.length}</strong> crew</span></div>
        ${renderTimesheetRows(crewEntries, foremanReadOnly() ? "No time has been recorded for this job yet." : "Add crew time to start this week's timesheet.", !foremanReadOnly())}
        ${peopleTotalsMarkup(crewPeopleTotals, "Week by crew member")}
      </section>
      ${contractors.length || contractorEntries.length
        ? `<section class="card panel">
            <div class="panel-head"><div><h2 class="panel-title">Contractor timesheets</h2><p class="panel-subtitle">Hours for contractor crew assigned to this project</p></div>${foremanReadOnly() ? "" : `<button class="text-link" data-action="contractor-time" data-job-id="${escapeHtml(job.id)}">Add contractor time</button>`}</div>
            <div class="foreman-time-summary"><span><strong>${hoursLabel(contractorTotals.today)}</strong> today</span><span><strong>${hoursLabel(contractorTotals.week)}</strong> this week</span><span><strong>${contractors.length}</strong> contractor${contractors.length === 1 ? "" : "s"}</span></div>
            ${renderTimesheetRows(contractorEntries, foremanReadOnly() ? "No contractor time has been recorded for this job yet." : "Add contractor time to record hours for this job.", !foremanReadOnly())}
            ${peopleTotalsMarkup(contractorPeopleTotals, "Week by contractor")}
          </section>`
        : `<section class="card panel">
            <div class="panel-head"><div><h2 class="panel-title">Contractor timesheets</h2><p class="panel-subtitle">Contractor hours for this project</p></div></div>
            <div class="empty-state"><strong>No contractors on this job</strong>Contractor timesheets appear when contractor crew are assigned to the project.</div>
          </section>`}
      <section class="card panel">
        <div class="panel-head"><div><h2 class="panel-title">Safety reports</h2><p class="panel-subtitle">JSA, FLHA, DHLA, and tailgate records for this job</p></div>${foremanReadOnly() ? "" : `<button class="text-link" data-action="new-safety" data-job-id="${escapeHtml(job.id)}">New report</button>`}</div>
        ${safetyReports.length ? `<div class="foreman-report-list">${safetyReports.map((form) => `<div class="foreman-report-row"><div><strong>${escapeHtml(form.title)}</strong><span>${form.workDate ? formatDate(form.workDate) : `Updated ${formatDate(form.updated)}`} · ${escapeHtml(form.owner || "Crew")}${(form.signatures || []).length ? ` · ${form.signatures.length} signature${form.signatures.length === 1 ? "" : "s"}` : ""}${form.documentName ? " · PDF attached" : ""}</span></div>${statusPill(form.status)}<div class="foreman-report-actions">${(form.signatures || []).length ? `<button class="text-link" data-print-safety-record="${escapeHtml(form.id)}">Print</button>` : ""}${foremanReadOnly() ? "" : `<button class="text-link" data-safety-form="${escapeHtml(form.id)}">${form.status === "Current" ? "View" : "Complete"}</button>`}</div></div>`).join("")}</div>` : `<div class="empty-state"><strong>No safety reports yet</strong>${foremanReadOnly() ? "No safety reports are recorded for this job yet." : "Create a JSA or today's FLHA / tailgate report, or fill out a custom safety form."}</div>`}
        ${jobSafetyLibraryDocumentsMarkup(job, assignedSafetyDocuments)}
      </section>
    </div>`;
}

function dateIsInAnalyticsRange(date) {
  if (!date) return true;
  return (!analyticsFilters.start || date >= analyticsFilters.start)
    && (!analyticsFilters.end || date <= analyticsFilters.end);
}

function analyticsData() {
  const contractorJobs = analyticsFilters.contractorId
    ? new Set([
      ...state.invoices.filter((invoice) => invoice.contractorId === analyticsFilters.contractorId).map((invoice) => invoice.jobId),
      ...state.contractorSubmissions.filter((submission) => submission.contractorId === analyticsFilters.contractorId).map((submission) => submission.jobId),
    ])
    : null;
  const jobs = state.jobs.filter((job) => {
    const start = job.startDate || job.date || "";
    const end = job.endDate || job.date || "";
    const matchesDate = (!analyticsFilters.start || end >= analyticsFilters.start)
      && (!analyticsFilters.end || start <= analyticsFilters.end);
    return matchesDate && (!analyticsFilters.jobId || job.id === analyticsFilters.jobId)
      && (!contractorJobs || contractorJobs.has(job.id));
  });
  const jobIds = new Set(jobs.map((job) => job.id));
  const jobMatches = (id) => !id || jobIds.has(id);
  const tasks = state.tasks.filter((task) => dateIsInAnalyticsRange(task.due) && task.jobIds.some(jobMatches));
  const runs = state.runs.filter((run) => dateIsInAnalyticsRange(run.date) && jobMatches(run.jobId));
  const safety = state.safety.filter((form) => dateIsInAnalyticsRange(form.workDate || form.updated) && jobMatches(form.jobId));
  const reports = state.reports.filter((report) => dateIsInAnalyticsRange(report.date) && jobMatches(report.jobId));
  const invoices = state.invoices.filter((invoice) => dateIsInAnalyticsRange(invoice.due)
    && jobMatches(invoice.jobId)
    && (!analyticsFilters.contractorId || invoice.contractorId === analyticsFilters.contractorId));
  const submissions = state.contractorSubmissions.filter((submission) => dateIsInAnalyticsRange(submission.date)
    && jobMatches(submission.jobId)
    && (!analyticsFilters.contractorId || submission.contractorId === analyticsFilters.contractorId));
  return { jobs, jobIds, tasks, runs, safety, reports, invoices, submissions };
}

function analyticsDateExtent(data) {
  const dates = [
    ...data.tasks.map((item) => item.due),
    ...data.runs.map((item) => item.date),
    ...data.safety.map((item) => item.workDate || item.updated),
    ...data.reports.map((item) => item.date),
    ...data.invoices.map((item) => item.due),
    ...data.submissions.map((item) => item.date),
    ...data.jobs.flatMap((job) => [job.startDate || job.date, job.endDate || job.date]),
  ].filter(Boolean).filter(dateIsInAnalyticsRange).sort();
  return {
    start: analyticsFilters.start || dates[0] || dateOffset(0),
    end: analyticsFilters.end || dates[dates.length - 1] || dateOffset(0),
  };
}

function analyticsTimeline(data) {
  const extent = analyticsDateExtent(data);
  const first = new Date(`${extent.start}T12:00:00`);
  const last = new Date(`${extent.end}T12:00:00`);
  const days = Math.max(1, Math.floor((last - first) / 86400000) + 1);
  const count = Math.min(days, 7);
  const bins = Array.from({ length: count }, (_, index) => {
    const offset = Math.floor(index * days / count);
    const date = new Date(first);
    date.setDate(first.getDate() + offset);
    return { start: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`, tasks: 0, runs: 0, hours: 0 };
  });
  const binFor = (date) => {
    if (!date || date < extent.start || date > extent.end) return null;
    const offset = Math.floor((new Date(`${date}T12:00:00`) - first) / 86400000);
    return bins[Math.min(count - 1, Math.floor(offset * count / days))];
  };
  data.tasks.forEach((task) => { const bin = binFor(task.due); if (bin && task.done) bin.tasks += 1; });
  data.runs.forEach((run) => { const bin = binFor(run.date); if (bin && /complete/i.test(run.status)) bin.runs += 1; });
  data.submissions.forEach((submission) => { const bin = binFor(submission.date); if (bin) bin.hours += Number(submission.hours || 0); });
  return bins;
}

function analyticsJobRows(data) {
  return data.jobs.map((job) => {
    const tasks = data.tasks.filter((task) => task.jobIds.includes(job.id));
    const runs = data.runs.filter((run) => run.jobId === job.id);
    const forms = data.safety.filter((form) => form.jobId === job.id);
    const reports = data.reports.filter((report) => report.jobId === job.id);
    const invoices = data.invoices.filter((invoice) => invoice.jobId === job.id);
    const submissions = data.submissions.filter((submission) => submission.jobId === job.id);
    const unbilledApproved = submissions.filter((submission) => submission.status === "Approved" && !submission.invoiceId)
      .map((submission) => roundCurrency(contractorSubmissionAmount(submission)));
    const invoiceSubtotal = invoices.reduce((sum, invoice) => sum + roundCurrency(invoice.amount), 0);
    const gst = invoices.reduce((sum, invoice) => sum + gstFor(invoice.amount), 0)
      + unbilledApproved.reduce((sum, subtotal) => sum + gstFor(subtotal), 0);
    const subtotal = roundCurrency(invoiceSubtotal + unbilledApproved.reduce((sum, amount) => sum + amount, 0));
    return {
      job, taskCount: tasks.length, completedTasks: tasks.filter((task) => task.done).length,
      runCount: runs.length, completedRuns: runs.filter((run) => /complete/i.test(run.status)).length,
      safetyCount: forms.length, currentSafety: forms.filter((form) => form.status === "Current").length,
      reportCount: reports.length, submittedReports: reports.filter((report) => report.status === "Submitted").length,
      subtotal, gst, spend: subtotal + gst,
    };
  });
}

function renderAnalytics() {
  const data = analyticsData();
  const rows = analyticsJobRows(data);
  const taskCompletion = data.tasks.length ? Math.round(data.tasks.filter((task) => task.done).length / data.tasks.length * 100) : 0;
  const safetyCompliance = data.safety.length ? Math.round(data.safety.filter((form) => form.status === "Current").length / data.safety.length * 100) : 0;
  const totalSpend = rows.reduce((sum, row) => sum + row.spend, 0);
  const pendingInvoices = data.invoices.filter((invoice) => invoice.status === "Pending");
  const pendingSpend = pendingInvoices.reduce((sum, invoice) => sum + invoiceTotal(invoice.amount), 0);
  const awaitingContractorApproval = data.submissions.filter((submission) => submission.status === "Pending").length;
  const timeline = analyticsTimeline(data);
  const maxActivity = Math.max(1, ...timeline.flatMap((item) => [item.tasks, item.runs, item.hours]));
  const jobChart = rows.length ? rows.map((row) => {
    const pct = row.taskCount ? Math.round(row.completedTasks / row.taskCount * 100) : 0;
    return `<button class="bi-job-bar ${analyticsFilters.jobId === row.job.id ? "selected" : ""}" data-bi-job="${escapeHtml(row.job.id)}" title="Filter analytics to ${escapeHtml(row.job.name)}"><span class="bi-job-label">${escapeHtml(row.job.name)}</span><span class="bi-bar-track"><span class="bi-bar-fill" style="width:${pct}%"></span></span><span class="bi-bar-value">${row.completedTasks}/${row.taskCount} tasks</span></button>`;
  }).join("") : `<div class="empty-state">No jobs match these filters.</div>`;
  const timelineChart = timeline.map((bin) => {
    const label = formatDate(bin.start);
    const height = (value) => Math.round(value / maxActivity * 100);
    return `<div class="bi-time-column"><div class="bi-time-bars"><span class="bi-time-bar tasks" style="height:${height(bin.tasks)}%" title="${bin.tasks} tasks completed"></span><span class="bi-time-bar runs" style="height:${height(bin.runs)}%" title="${bin.runs} runs completed"></span><span class="bi-time-bar hours" style="height:${height(bin.hours)}%" title="${bin.hours} contractor hours"></span></div><span class="bi-time-label">${label}</span></div>`;
  }).join("");
  const contractorTotals = new Map();
  data.invoices.forEach((invoice) => {
    const id = invoice.contractorId || "";
    contractorTotals.set(id, (contractorTotals.get(id) || 0) + invoiceTotal(invoice.amount));
  });
  data.submissions.filter((submission) => submission.status === "Approved" && !submission.invoiceId).forEach((submission) => {
    contractorTotals.set(submission.contractorId, (contractorTotals.get(submission.contractorId) || 0) + invoiceTotal(contractorSubmissionAmount(submission)));
  });
  const companyRows = [...contractorTotals.entries()].map(([id, amount]) => ({ id, name: contractorById(id)?.name || "Other", amount }))
    .sort((a, b) => b.amount - a.amount);
  const maxCompanySpend = Math.max(1, ...companyRows.map((row) => row.amount));
  const companyChart = companyRows.length ? companyRows.map((row) => `<button class="bi-company-bar ${analyticsFilters.contractorId === row.id ? "selected" : ""}" data-bi-company="${escapeHtml(row.id)}" title="Filter analytics to ${escapeHtml(row.name)}"><span>${escapeHtml(row.name)}</span><i><b style="width:${Math.round(row.amount / maxCompanySpend * 100)}%"></b></i><strong>${money(row.amount)}</strong></button>`).join("") : `<div class="empty-state">No contractor spend matches these filters.</div>`;
  const allReports = state.reports.length > 0;
  const extent = analyticsDateExtent(data);
  const exportButtons = `<button class="button button-outline" data-action="analytics-excel">↓ Export Excel</button><button class="button button-outline" data-action="analytics-export">Export CSV</button><button class="button button-outline" data-action="analytics-print">Print / Save PDF</button>`;
  return `${heading("OPERATIONS INTELLIGENCE", "Analytics", "Explore field performance, contractor costs, and compliance across your workspace.", exportButtons)}
    <section class="card bi-filter-bar"><div class="bi-filter-title"><strong>Filters</strong><span>Changes update every visual</span></div>
      <label>From <input type="date" id="bi-start" value="${escapeHtml(analyticsFilters.start)}" max="${escapeHtml(analyticsFilters.end || "")}"></label>
      <label>To <input type="date" id="bi-end" value="${escapeHtml(analyticsFilters.end)}" min="${escapeHtml(analyticsFilters.start || "")}"></label>
      <label>Job <select id="bi-job"><option value="">All jobs</option>${state.jobs.map((job) => `<option value="${escapeHtml(job.id)}" ${analyticsFilters.jobId === job.id ? "selected" : ""}>${escapeHtml(job.name)}</option>`).join("")}</select></label>
      <label>Contractor <select id="bi-contractor"><option value="">All companies</option>${state.contractors.map((company) => `<option value="${escapeHtml(company.id)}" ${analyticsFilters.contractorId === company.id ? "selected" : ""}>${escapeHtml(company.name)}</option>`).join("")}</select></label>
      <button class="text-link bi-reset" data-action="analytics-reset">Reset</button>
    </section>
    <div class="bi-context">Showing ${rows.length} of ${state.jobs.length} jobs · ${formatDate(extent.start, { month: "short", day: "numeric", year: "numeric" })} – ${formatDate(extent.end, { month: "short", day: "numeric", year: "numeric" })}${analyticsFilters.jobId ? ` · Job: ${escapeHtml(jobById(analyticsFilters.jobId)?.name || "")}` : ""}${analyticsFilters.contractorId ? ` · Company: ${escapeHtml(contractorById(analyticsFilters.contractorId)?.name || "")}` : ""}</div>
    <div class="metric-grid bi-metrics">
      <article class="card metric-card"><div class="metric-top">Jobs in view <span class="metric-icon">▦</span></div><div class="metric-value">${rows.length}</div><div class="metric-note">${rows.filter((row) => /progress/i.test(row.job.status)).length} currently active</div></article>
      <article class="card metric-card"><div class="metric-top">Task completion <span class="metric-icon">☷</span></div><div class="metric-value">${taskCompletion}%</div><div class="metric-note">${data.tasks.filter((task) => task.done).length} of ${data.tasks.length} tasks complete</div></article>
      <article class="card metric-card"><div class="metric-top">Tool runs <span class="metric-icon">◎</span></div><div class="metric-value">${data.runs.length}</div><div class="metric-note">${data.runs.filter((run) => /complete/i.test(run.status)).length} completed runs</div></article>
      <article class="card metric-card"><div class="metric-top">Safety current <span class="metric-icon">◇</span></div><div class="metric-value">${safetyCompliance}%</div><div class="metric-note">${data.safety.filter((form) => form.status !== "Current").length} forms need review</div></article>
      <article class="card metric-card"><div class="metric-top">Contractor spend incl. GST <span class="metric-icon">$</span></div><div class="metric-value">${money(totalSpend)}</div><div class="metric-note">${pendingInvoices.length} invoices pending · ${money(pendingSpend)} incl. GST</div></article>
      <article class="card metric-card"><div class="metric-top">Contractor submissions <span class="metric-icon">◷</span></div><div class="metric-value">${data.submissions.length}</div><div class="metric-note">${awaitingContractorApproval} awaiting approval</div></article>
    </div>
    <div class="bi-grid">
      <section class="card panel"><div class="panel-head"><div><h2 class="panel-title">Job task completion</h2><p class="panel-subtitle">Select a job to cross-filter the report</p></div></div><div class="bi-job-chart">${jobChart}</div></section>
      <section class="card panel"><div class="panel-head"><div><h2 class="panel-title">Activity over time</h2><p class="panel-subtitle">Completed tasks, runs, and contractor hours</p></div></div>
        <div class="bi-legend"><span><i class="tasks"></i>Tasks</span><span><i class="runs"></i>Runs</span><span><i class="hours"></i>Hours</span></div>
        <div class="bi-timeline">${timelineChart}</div>
      </section>
      <section class="card panel"><div class="panel-head"><div><h2 class="panel-title">Contractor spend</h2><p class="panel-subtitle">Invoices plus approved, unbilled submissions</p></div></div><div class="bi-company-chart">${companyChart}</div></section>
      <section class="card panel"><div class="panel-head"><div><h2 class="panel-title">Operational snapshot</h2><p class="panel-subtitle">Filtered field records</p></div></div>
        <div class="bi-snapshot"><div><span>Safety forms</span><strong>${data.safety.filter((form) => form.status === "Current").length} / ${data.safety.length} current</strong><i><b style="width:${safetyCompliance}%"></b></i></div><div><span>Daily reports</span><strong>${data.reports.filter((report) => report.status === "Submitted").length} / ${data.reports.length} submitted</strong><i><b style="width:${data.reports.length ? Math.round(data.reports.filter((report) => report.status === "Submitted").length / data.reports.length * 100) : 0}%"></b></i></div><div><span>Contractor approvals</span><strong>${data.submissions.filter((item) => item.status === "Approved" || item.status === "Invoiced").length} approved · ${awaitingContractorApproval} pending</strong><i><b style="width:${data.submissions.length ? Math.round(data.submissions.filter((item) => item.status === "Approved" || item.status === "Invoiced").length / data.submissions.length * 100) : 0}%"></b></i></div>${allReports ? "" : `<p class="form-hint">Daily report data appears here when jobs have scheduled report workflows.</p>`}</div>
      </section>
    </div>
    <section class="card panel bi-job-table"><div class="panel-head"><div><h2 class="panel-title">Job performance detail</h2><p class="panel-subtitle">Click any job to filter the whole analytics page</p></div><span class="table-secondary">Excel and CSV exports follow the current filters · spend includes 5% Alberta GST</span></div>
      ${rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Job</th><th>Status</th><th>Tasks</th><th>Runs</th><th>Safety</th><th>Reports</th><th>Contractor spend (incl. GST)</th></tr></thead><tbody>${rows.map((row) => `<tr class="bi-clickable-row" data-bi-job="${escapeHtml(row.job.id)}" tabindex="0"><td><span class="table-primary">${escapeHtml(row.job.name)}</span><span class="table-secondary">${escapeHtml(row.job.client)}</span></td><td>${statusPill(row.job.status)}</td><td>${row.completedTasks}/${row.taskCount}</td><td>${row.completedRuns}/${row.runCount}</td><td>${row.currentSafety}/${row.safetyCount}</td><td>${row.submittedReports}/${row.reportCount}</td><td><strong>${money(row.spend)}</strong></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No job data for these filters</strong>Adjust or reset your filters to see analytics.</div>`}
    </section>`;
}

function analyticsCsvRows() {
  const data = analyticsData();
  return analyticsJobRows(data).map((row) => ({
    job: row.job.name, client: row.job.client, status: row.job.status,
    startDate: row.job.startDate || row.job.date, endDate: row.job.endDate || row.job.date,
    progressPercent: row.job.progress, tasksCompleted: row.completedTasks, tasksTotal: row.taskCount,
    runsCompleted: row.completedRuns, runsTotal: row.runCount, safetyCurrent: row.currentSafety,
    safetyForms: row.safetyCount, reportsSubmitted: row.submittedReports, reportsTotal: row.reportCount,
    contractorSubtotalCAD: row.subtotal,
    albertaGST5PercentCAD: row.gst,
    contractorTotalCAD: row.spend,
  }));
}

function exportAnalyticsExcel() {
  downloadWorkbook(analyticsCsvRows(), `fieldwork-analytics-${dateOffset(0)}.xlsx`, "Job analytics");
}

function exportContractorInvoicesExcel() {
  const isContractor = userProfile?.role === "contractor";
  const isLegacyInvoicePage = !isContractor && activePage === "invoices";
  const invoices = isContractor ? contractorWorkflow.invoices : isLegacyInvoicePage ? state.invoices : adminContractorInvoices;
  const rows = contractorInvoiceExportRows(
    invoices,
    (companyId) => isContractor ? contractorCompany : isLegacyInvoicePage ? contractorById(companyId) : contractorCompaniesCache.find((company) => company.id === companyId),
    (jobId) => isContractor
      ? contractorWorkflow.jobs.find((job) => job.job_id === jobId)?.job_name
      : jobById(jobId)?.name,
  );
  downloadWorkbook(rows, `fieldwork-contractor-invoices-${dateOffset(0)}.xlsx`, "Contractor invoices");
}

function exportAnalyticsCsv() {
  const rows = analyticsCsvRows();
  if (!rows.length) {
    showToast("There is no job data to export for these filters.");
    return;
  }
  const columns = Object.keys(rows[0]);
  const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => {
    const value = String(row[column] ?? "");
    return `"${value.replace(/"/g, '""')}"`;
  }).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `fieldwork-analytics-${dateOffset(0)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`${rows.length} job rows exported with Alberta GST.`);
}

function renderJobs() {
  const y = calendarDate.getFullYear(), m = calendarDate.getMonth();
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const monthName = calendarDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const monthStart = `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const monthEnd = `${y}-${String(m + 1).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  const viewToggle = `<div class="schedule-view-toggle" role="group" aria-label="Job schedule view"><button type="button" data-action="calendar-view" data-view="calendar" aria-pressed="${jobScheduleView === "calendar"}" class="${jobScheduleView === "calendar" ? "selected" : ""}">Calendar</button><button type="button" data-action="calendar-view" data-view="gantt" aria-pressed="${jobScheduleView === "gantt"}" class="${jobScheduleView === "gantt" ? "selected" : ""}">Gantt</button></div>`;
  let days = "";
  for (let i = 0; i < 42; i++) {
    let dayNum, date, isDim = false;
    if (i < firstDay) { dayNum = prevDays - firstDay + i + 1; date = new Date(y, m - 1, dayNum); isDim = true; }
    else if (i >= firstDay + daysInMonth) { dayNum = i - firstDay - daysInMonth + 1; date = new Date(y, m + 1, dayNum); isDim = true; }
    else { dayNum = i - firstDay + 1; date = new Date(y, m, dayNum); }
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const items = state.jobs.filter((job) => {
      const start = job.startDate || job.date;
      const end = job.endDate || job.date;
      return start <= key && key <= end;
    }).slice(0, 2);
    const runs = state.runs.filter((run) => run.date === key).slice(0, 1);
    days += `<div class="calendar-day ${isDim ? "dim" : ""} ${key === dateOffset(0) ? "today" : ""}"><span class="day-number">${dayNum}</span>${items.map((job) => `<div class="calendar-event">${escapeHtml(job.name.split("—")[0].trim())}</div>`).join("")}${runs.map((run) => `<div class="calendar-event orange">${escapeHtml(run.type)} run</div>`).join("")}</div>`;
  }
  const ganttJobs = state.jobs.filter((job) => (job.endDate || job.startDate || job.date) >= monthStart && (job.startDate || job.date) <= monthEnd);
  const ganttDays = Array.from({ length: daysInMonth }, (_, index) => {
    const date = new Date(y, m, index + 1);
    return `<span class="gantt-day ${dateOffset(0) === `${y}-${String(m + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}` ? "today" : ""}">${index + 1}</span>`;
  }).join("");
  const dayOffset = (date) => Math.round((new Date(`${date}T12:00:00`) - new Date(`${monthStart}T12:00:00`)) / 86400000);
  const ganttRows = ganttJobs.slice().sort((a, b) => (a.startDate || a.date).localeCompare(b.startDate || b.date)).map((job) => {
    const start = job.startDate || job.date;
    const end = job.endDate || job.date || start;
    const left = Math.max(0, dayOffset(start));
    const right = Math.min(daysInMonth - 1, dayOffset(end));
    const width = Math.max(1, right - left + 1);
    const ganttStatus = /complete/i.test(job.status) ? "complete" : /progress/i.test(job.status) ? "progress" : "scheduled";
    return `<div class="gantt-row"><div class="gantt-job-label"><strong>${escapeHtml(job.name)}</strong><span>${escapeHtml(job.client)} · ${statusPill(job.status)}</span></div><div class="gantt-track" style="background-size:${100 / daysInMonth}% 100%"><span class="gantt-bar ${ganttStatus}" style="--gantt-left:${left / daysInMonth * 100}%;--gantt-width:${width / daysInMonth * 100}%" title="${escapeHtml(job.name)} · ${formatDate(start)} – ${formatDate(end)}" aria-label="${escapeHtml(job.name)}, ${formatDate(start)} through ${formatDate(end)}">${escapeHtml(job.name)}</span></div></div>`;
  }).join("");
  const schedule = jobScheduleView === "gantt"
    ? `<div class="gantt-timeline" style="--gantt-days:${daysInMonth};--gantt-track-width:${daysInMonth * 28}px"><div class="gantt-header"><strong>Project</strong><div class="gantt-day-track">${ganttDays}</div></div>${ganttRows || `<div class="empty-state">No projects overlap this month.</div>`}</div>`
    : `<div class="calendar-grid">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<div class="weekday">${day}</div>`).join("")}${days}</div>`;
  return `${heading("FIELD PLANNING", "Jobs & calendar", "Plan work, check upcoming dates, and keep each job on track.", actionButton("Create job", "new-job"))}
    <div class="calendar-layout"><section class="card calendar-card"><div class="calendar-toolbar"><strong class="calendar-month">${monthName}</strong><div class="calendar-controls">${viewToggle}<button data-action="calendar-prev" aria-label="Previous month">‹</button><button data-action="calendar-today">Today</button><button data-action="calendar-next" aria-label="Next month">›</button></div></div>
      ${schedule}</section>
      <section class="card panel"><div class="panel-head"><div><h2 class="panel-title">Upcoming jobs</h2><p class="panel-subtitle">Your scheduled field work</p></div></div><div class="job-list">${state.jobs.slice().sort((a, b) => (a.startDate || a.date).localeCompare(b.startDate || b.date)).map((job) => `<div class="activity-item"><span class="activity-dot">⌖</span><div class="activity-text"><strong>${escapeHtml(job.name)}</strong><small>${formatDate(job.startDate || job.date, { weekday: "short", month: "short", day: "numeric" })}${job.endDate && job.endDate !== (job.startDate || job.date) ? ` – ${formatDate(job.endDate, { month: "short", day: "numeric" })}` : ""} · ${escapeHtml(job.location)}</small></div></div>`).join("") || `<div class="empty-state">No scheduled jobs yet.</div>`}</div></section></div>
    <section class="card panel" style="margin-top:15px"><div class="panel-head"><div><h2 class="panel-title">All jobs</h2><p class="panel-subtitle">${state.jobs.length} jobs in your workspace</p></div></div>${renderJobList()}</section>`;
}

function renderJobSafetySummary(job) {
  const templates = (state.safetyTemplates || []).filter((template) => template.jobId === job.id);
  const documents = (state.safetyLibrary || []).filter((document) => document.jobId === job.id);
  const completed = state.safety
    .filter((form) => form.jobId === job.id && form.status === "Current")
    .slice()
    .sort((first, second) => String(second.workDate || second.updated || "").localeCompare(String(first.workDate || first.updated || "")));
  const assignedCount = templates.length + documents.length;
  const assigned = [
    ...templates.map((template) => `<li><span>${escapeHtml(template.name)} <small>Form</small></span><button type="button" class="text-link" data-fill-template="${escapeHtml(template.id)}" data-job-id="${escapeHtml(job.id)}">Fill out</button></li>`),
    ...documents.map((document) => `<li><span>${escapeHtml(document.title)} <small>${escapeHtml(document.category || "PDF")}</small></span><button type="button" class="text-link" data-safety-library-view="${escapeHtml(document.id)}">View PDF</button></li>`),
  ].join("");
  const completedItems = completed.map((form) => `<li><span>${escapeHtml(form.title)} <small>${form.workDate ? formatDate(form.workDate, { month: "short", day: "numeric", year: "numeric" }) : form.updated ? `Updated ${formatDate(form.updated, { month: "short", day: "numeric", year: "numeric" })}` : "Current"}</small></span><button type="button" class="text-link" data-safety-form="${escapeHtml(form.id)}">Review</button><button type="button" class="text-link" data-print-safety-record="${escapeHtml(form.id)}">Print</button></li>`).join("");
  return `<details class="job-safety-summary"><summary>Safety: ${assignedCount} assigned · ${completed.length} current</summary>
    <div class="job-safety-summary-content">
      <strong>Assigned forms &amp; PDFs</strong>${assigned ? `<ul>${assigned}</ul>` : `<p>No forms or PDFs specifically assigned to this job.</p>`}
      <strong>Current safety records</strong>${completedItems ? `<ul>${completedItems}</ul>` : `<p>No current FLHA, tailgate, JSA, or other safety records.</p>`}
    </div></details>`;
}

function renderJobList() {
  if (!state.jobs.length) return `<div class="empty-state"><strong>No jobs yet</strong>Create a job to get started.</div>`;
  const scopeLabels = {
    objectives: "Project objectives",
    includedWork: "Included work",
    deliverables: "Deliverables",
    exclusions: "Exclusions",
    acceptanceCriteria: "Acceptance criteria",
  };
  return `<div class="job-list">${state.jobs.map((job) => {
    const scope = job.scopeOfWork || {};
    const hasScope = Object.values(scope).some((value) => String(value || "").trim());
    const dailyPlan = Array.isArray(job.dailyPlan) ? job.dailyPlan : [];
    const assignedCrew = Array.isArray(job.crewMembers) ? job.crewMembers : [];
    const scopeDetails = hasScope
      ? `<details class="scope-of-work"><summary>Scope of work · defined</summary><div class="scope-sections">${Object.entries(scopeLabels).filter(([key]) => String(scope[key] || "").trim()).map(([key, label]) => `<section><h3>${label}</h3><p>${escapeHtml(scope[key])}</p></section>`).join("")}</div></details>`
      : `<p class="scope-status">Scope of work not added yet.</p>`;
    const dailyPlanDetails = dailyPlan.length
      ? `<details class="daily-job-plan-details"><summary>Daily work plan · ${dailyPlan.length} days</summary><div class="daily-job-plan-summary">${dailyPlan.map((day) => `<section><strong>${formatDate(day.date, { weekday: "short", month: "short", day: "numeric" })} · ${escapeHtml(day.assignee || "Unassigned")}</strong><ul>${(Array.isArray(day.tasks) ? day.tasks : [day.tasks]).map((task) => `<li>${escapeHtml(task)}</li>`).join("")}</ul></section>`).join("")}</div></details>`
      : "";
    return `<div class="job-card"><div class="job-symbol">⌖</div><div class="job-info"><strong>${escapeHtml(job.name)}</strong><p>${escapeHtml(job.client)} · ${escapeHtml(job.location)}${job.companyName ? ` · ${escapeHtml(job.companyName)}` : ""} · Foreman: ${escapeHtml(jobForemanName(job) || "Unassigned")}${assignedCrew.length ? ` · Crew: ${assignedCrew.map(escapeHtml).join(", ")}` : ""}</p>${scopeDetails}${dailyPlanDetails}<div class="job-card-actions"><button class="button button-outline scope-edit-button" data-scope-job="${escapeHtml(job.id)}">${hasScope ? "Edit scope of work" : "Create scope of work"}</button><button class="button button-outline" data-action="assign-foreman" data-job-id="${escapeHtml(job.id)}">${job.foremanUserId ? "Reassign foreman" : "Assign foreman"}</button><button class="button button-primary" data-action="open-gps-workspace" data-job-id="${escapeHtml(job.id)}">GPS workspace</button></div></div><div class="job-meta">${formatDate(job.startDate || job.date)}${job.endDate && job.endDate !== (job.startDate || job.date) ? ` – ${formatDate(job.endDate)}` : ""}</div><div class="job-right">${statusPill(job.status)}${renderJobSafetySummary(job)}<div class="progress-wrap"><div class="progress-label"><span>Progress</span><span>${job.progress}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, Math.max(0, Number(job.progress) || 0))}%"></div></div></div></div></div>`;
  }).join("")}</div>`;
}

function renderTasks() {
  const tasks = state.tasks.slice().sort((a, b) => a.due.localeCompare(b.due));
  return `${heading("CREW WORKFLOW", "Daily tasks", "Assign work to one or more jobs and keep the crew in sync.", actionButton("Assign task", "new-task"))}
    <div class="metric-grid">
      <article class="card metric-card"><div class="metric-top">Open tasks <span class="metric-icon">☷</span></div><div class="metric-value">${state.tasks.filter((task) => !task.done).length}</div><div class="metric-note">Across all active jobs</div></article>
      <article class="card metric-card"><div class="metric-top">Due today <span class="metric-icon">◷</span></div><div class="metric-value">${state.tasks.filter((task) => task.due === dateOffset(0) && !task.done).length}</div><div class="metric-note">Tasks for the current shift</div></article>
      <article class="card metric-card"><div class="metric-top">Completed <span class="metric-icon">✓</span></div><div class="metric-value">${state.tasks.filter((task) => task.done).length}</div><div class="metric-note">Marked complete by your team</div></article>
      <article class="card metric-card"><div class="metric-top">Team members <span class="metric-icon">♙</span></div><div class="metric-value">${state.people.length}</div><div class="metric-note">Available in this workspace</div></article>
    </div>
    <section class="card panel"><div class="panel-head"><div><h2 class="panel-title">Assignment board</h2><p class="panel-subtitle">Select a task to mark it complete</p></div></div>${tasks.length ? tasks.map((task) => `<div class="task-row"><input class="task-check" type="checkbox" data-task="${task.id}" ${task.done ? "checked" : ""} aria-label="Mark ${escapeHtml(task.title)} complete"><div class="task-name"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(jobNames(task.jobIds))}</span></div><span class="task-assignee"><span class="avatar">${initials(task.assignee)}</span>${escapeHtml(task.assignee)}</span><span>${formatDate(task.due, { month: "short", day: "numeric", year: "numeric" })}</span>${task.done ? statusPill("Complete") : statusPill(task.priority === "High" ? "High priority" : "Open")}</div>`).join("") : `<div class="empty-state"><strong>No tasks assigned</strong>Create a task and assign it to one or more jobs.</div>`}</section>`;
}

function renderRuns() {
  const runs = state.runs.slice().sort((a, b) => b.date.localeCompare(a.date));
  return `${heading("FIELD ACTIVITY", "Tool runs", "Track ILI, cleaning, gauging, and other tool activity by job.", actionButton("Log a run", "new-run"))}
    <div class="metric-grid">
      ${["ILI", "Cleaning", "Gauging", "Other"].map((type) => `<article class="card metric-card"><div class="metric-top">${type} runs <span class="metric-icon">${type === "ILI" ? "◎" : type === "Cleaning" ? "⌁" : type === "Gauging" ? "◉" : "·"}</span></div><div class="metric-value">${state.runs.filter((run) => run.type === type).length.toString().padStart(2, "0")}</div><div class="metric-note">${type === "Other" ? "Additional tool activity" : `${state.runs.filter((run) => run.type === type && run.status !== "Complete").length} active or planned`}</div></article>`).join("")}
    </div>
    <section class="card panel"><div class="panel-head"><div><h2 class="panel-title">Run register</h2><p class="panel-subtitle">Run history and upcoming operations</p></div></div>${runs.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Run / tool</th><th>Job</th><th>Operator</th><th>Run date</th><th>Status</th></tr></thead><tbody>${runs.map((run) => `<tr><td><span class="table-primary">${escapeHtml(run.type)} run <span class="run-type">${escapeHtml(run.type)}</span></span><span class="table-secondary">${escapeHtml(run.tool)}${run.notes ? ` · ${escapeHtml(run.notes)}` : ""}</span></td><td>${escapeHtml(shortJobName(run.jobId))}</td><td>${escapeHtml(run.operator)}</td><td>${formatDate(run.date, { month: "short", day: "numeric", year: "numeric" })}</td><td>${statusPill(run.status)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No tool runs recorded</strong>Log a run to build your activity register.</div>`}</section>`;
}

function renderTrackingTools() {
  const selectedJob = state.jobs.find((job) => job.id === gpsWorkspaceJobId) || state.jobs[0];
  if (selectedJob) gpsWorkspaceJobId = selectedJob.id;
  return `${heading("GPS CALCULATIONS", "Tracking Tools", "Calculate distances, convert coordinates, project points, and check GPS data.")}
    ${window.GPSCalculations.render(gpsCalculatorMode, state.jobs, selectedJob?.id || "", gpsCalculatorAutoAdd)}`;
}

function renderGpsWorkspace() {
  const selectedJob = state.jobs.find((job) => job.id === gpsWorkspaceJobId) || state.jobs[0];
  if (selectedJob) gpsWorkspaceJobId = selectedJob.id;
  return `<div id="gps-workspace-root">${window.GPSWorkspace.render(state.jobs, selectedJob?.id || "")}</div>`;
}

function renderPeople() {
  return `${heading("CREW & ASSETS", "People & equipment", "Assign team members and field equipment to the right jobs.", `<button class="button button-outline" data-action="new-equipment">＋ Add equipment</button>${actionButton("Add person", "new-person")}`)}
    <section class="card panel" style="margin-bottom:15px"><div class="panel-head"><div><h2 class="panel-title">Team members</h2><p class="panel-subtitle">Crew assignment by company and job</p></div></div>${state.people.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Company</th><th>Role</th><th>Assigned jobs</th></tr></thead><tbody>${state.people.map((person) => `<tr><td><span class="task-assignee"><span class="avatar">${initials(person.name)}</span><strong>${escapeHtml(person.name)}</strong></span></td><td>${escapeHtml(jobAssignmentCompanies().find((company) => company.id === person.companyId)?.name || "Workspace team")}</td><td>${escapeHtml(person.role)}</td><td>${escapeHtml(jobNames(person.jobIds))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No team members</strong>Add people and assign them to jobs.</div>`}</section>
    <section class="card panel"><div class="panel-head"><div><h2 class="panel-title">Equipment register</h2><p class="panel-subtitle">${state.equipment.length} registered assets · add the equipment names and categories your operation uses.</p></div></div>${state.equipment.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Equipment</th><th>Category</th><th>Serial</th><th>Assigned job</th><th>Status</th></tr></thead><tbody>${state.equipment.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.type || "—")}</td><td>${escapeHtml(item.serial)}</td><td>${escapeHtml(shortJobName(item.jobId))}</td><td>${statusPill(item.status)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No equipment registered</strong>Add equipment to keep track of field assets.</div>`}</section>`;
}

function renderInvoices() {
  const pending = state.invoices.filter((invoice) => invoice.status === "Pending").reduce((sum, invoice) => sum + invoiceTotal(invoice.amount), 0);
  const approved = state.invoices.filter((invoice) => invoice.status === "Approved").reduce((sum, invoice) => sum + invoiceTotal(invoice.amount), 0);
  return `${heading("CONTRACTOR ADMIN", "Contractors & invoices", "Manage contractor companies and link invoices to jobs.", `<button class="button button-outline" data-action="new-contractor">＋ Add company</button>${actionButton("Add invoice", "new-invoice")}`)}
    <div class="invoice-summary"><article class="card summary-box"><span>Pending review</span><strong>${money(pending)}</strong></article><article class="card summary-box"><span>Approved</span><strong>${money(approved)}</strong></article><article class="card summary-box"><span>Invoices logged</span><strong>${state.invoices.length}</strong></article></div>
    <section class="card panel" style="margin-bottom:15px"><div class="panel-head"><div><h2 class="panel-title">Contractor companies</h2><p class="panel-subtitle">${state.contractors.length} companies available to assign to invoices</p></div></div>${state.contractors.length ? `<div class="crew-strip">${state.contractors.map((company) => `<span class="status-pill status-gray">${escapeHtml(company.name)}</span>`).join("")}</div>` : `<div class="empty-state"><strong>No companies added</strong>Add a company before entering its invoice.</div>`}</section>
    <section class="card panel invoice-export-section"><div class="panel-head"><div><h2 class="panel-title">Invoice register</h2><p class="panel-subtitle">Contractor invoice subtotals plus 5% Alberta GST, by company, job, and due date.</p></div><div class="heading-actions"><button class="button button-outline" data-action="invoice-excel">Export Excel</button><button class="button button-outline" data-action="invoice-print">Print / Save PDF</button></div></div>${state.invoices.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Company / invoice</th><th>Job</th><th>Subtotal</th><th>Alberta GST (5%)</th><th>Total (CAD)</th><th>Due date</th><th>Status</th><th></th></tr></thead><tbody>${state.invoices.map((invoice) => `<tr><td><span class="table-primary">${escapeHtml(invoiceCompany(invoice))}</span><span class="table-secondary">${escapeHtml(invoice.number)}</span></td><td>${escapeHtml(shortJobName(invoice.jobId))}</td><td>${money(invoice.amount)}</td><td>${money(gstFor(invoice.amount))}</td><td><strong>${money(invoiceTotal(invoice.amount))}</strong></td><td>${formatDate(invoice.due, { month: "short", day: "numeric", year: "numeric" })}</td><td>${statusPill(invoice.status)}</td><td>${invoice.status === "Pending" ? `<button class="text-link" data-approve-invoice="${invoice.id}">Approve</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No invoices logged</strong>Add a contractor invoice to get started.</div>`}</section>`;
}

function contractorSubmissionAmount(submission) {
  const contractor = contractorById(submission.contractorId);
  const hourlyRate = submission.hourlyRate !== undefined ? submission.hourlyRate : contractor?.pricing?.laborRates?.[submission.role];
  const equipmentDailyRate = submission.equipmentDailyRate !== undefined ? submission.equipmentDailyRate : contractor?.pricing?.equipmentRates?.[submission.equipmentType];
  const labor = Number(submission.hours || 0) * Number(hourlyRate || 0);
  const equipment = Number(submission.equipmentDays || 0) * Number(submission.equipmentQuantity || 0)
    * Number(equipmentDailyRate || 0);
  return labor + equipment;
}

function renderContractorWork() {
  const activeCompanies = contractorCompaniesCache;
  const invoices = adminContractorInvoices;
  const pending = invoices.filter((invoice) => invoice.status === "pending").length;
  const equipmentForCompany = (companyId) => adminContractorEquipment.filter((item) => item.company_id === companyId);
  const jobNamesForCompany = (companyId) => adminContractorAssignments
    .filter((item) => item.company_id === companyId)
    .map((item) => jobById(item.job_id)?.name || item.job_id);
  const companyCards = activeCompanies.map((company) => {
    const rates = adminContractorRates.find((item) => item.company_id === company.id);
    const assignments = jobNamesForCompany(company.id);
    const assets = equipmentForCompany(company.id);
    return `<article class="card contractor-company-card"><div class="contractor-company-copy"><span class="job-symbol">▤</span><div><strong>${escapeHtml(company.name)}</strong><small>${rates ? `Hourly ${money(rates.hourly_rate)} · subsistence ${money(rates.subsistence_daily_rate)}/day` : "Pricing not configured"} · ${assignments.length} assigned job${assignments.length === 1 ? "" : "s"} · ${assets.length} asset${assets.length === 1 ? "" : "s"}</small><div class="wcb-company-row">${contractorWcbControls(company)}</div></div></div><div class="contractor-actions"><button class="button button-outline" data-action="configure-contractor-workflow" data-company-id="${escapeHtml(company.id)}">Rates & jobs</button><button class="button button-outline" data-action="add-contractor-equipment" data-company-id="${escapeHtml(company.id)}">Add equipment</button></div></article>`;
  }).join("");
  return `${heading("CONTRACTOR WORKFLOW", "Contractor hours & equipment", "Configure company rates, assign jobs and owned assets, and review invoices.", `<button class="button button-outline" data-action="refresh-contractor-workflow">Refresh</button>`)}
    <div class="metric-grid">
      <article class="card metric-card"><div class="metric-top">Awaiting review <span class="metric-icon">◷</span></div><div class="metric-value">${pending}</div><div class="metric-note">Contractor invoices</div></article>
      <article class="card metric-card"><div class="metric-top">Reviewed invoices <span class="metric-icon">✓</span></div><div class="metric-value">${invoices.filter((invoice) => invoice.status === "approved").length}</div><div class="metric-note">Approved invoices</div></article>
      <article class="card metric-card"><div class="metric-top">Assigned jobs <span class="metric-icon">▦</span></div><div class="metric-value">${adminContractorAssignments.length}</div><div class="metric-note">Company/job assignments</div></article>
      <article class="card metric-card"><div class="metric-top">Contractor companies <span class="metric-icon">▤</span></div><div class="metric-value">${activeCompanies.length}</div><div class="metric-note">Registered companies</div></article>
    </div>
    <section class="card panel" style="margin-bottom:15px"><div class="panel-head"><div><h2 class="panel-title">Company rates, assignments & equipment</h2><p class="panel-subtitle">Set all required rates; selected equipment is available only on selected jobs.</p></div><button class="text-link" data-page="users">Approve companies & users →</button></div><div class="contractor-company-grid">${companyCards || `<div class="empty-state"><strong>No contractor companies</strong>Approved contractor companies appear here.</div>`}</div></section>
    <section class="card panel invoice-export-section"><div class="panel-head"><div><h2 class="panel-title">Contractor invoices</h2><p class="panel-subtitle">Rates are calculated and snapshotted when an invoice is submitted; 5% Alberta GST is applied to subtotals.</p></div><div class="heading-actions"><button class="button button-outline" data-action="invoice-excel">Export Excel</button><button class="button button-outline" data-action="invoice-print">Print / Save PDF</button></div></div>${invoices.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Company / invoice</th><th>Job / work date</th><th>Hours / equipment</th><th>Subtotal</th><th>Alberta GST (5%)</th><th>Total (CAD)</th><th>Status</th><th>Review</th></tr></thead><tbody>${invoices.map((invoice) => {
      const company = activeCompanies.find((item) => item.id === invoice.company_id);
      const usage = Array.isArray(invoice.equipment_usage) ? invoice.equipment_usage : [];
      return `<tr><td><span class="table-primary">${escapeHtml(company?.name || "Contractor")}</span><span class="table-secondary">${escapeHtml(invoice.invoice_number)}</span></td><td><span class="table-primary">${escapeHtml(jobById(invoice.job_id)?.name || invoice.job_id)}</span><span class="table-secondary">${formatDate(invoice.work_date)}</span></td><td><span class="table-primary">${Number(invoice.labor_hours)} h · ${Number(invoice.subsistence_days)} subsistence days</span><span class="table-secondary">${usage.map((item) => `${escapeHtml(item.name)} × ${Number(item.days)}d`).join(", ") || "No equipment"}</span></td><td>${money(invoice.amount)}</td><td>${money(gstFor(invoice.amount))}</td><td><strong>${money(invoiceTotal(invoice.amount))}</strong></td><td>${statusPill(invoice.status)}</td><td>${invoice.status === "pending" ? `<button class="text-link" data-invoice-review="${escapeHtml(invoice.id)}" data-status="approved">Approve</button><button class="text-link reject-link" data-invoice-review="${escapeHtml(invoice.id)}" data-status="rejected">Reject</button>` : `<span class="table-secondary">${escapeHtml(invoice.admin_notes || "Reviewed")}</span>`}</td></tr>`;
    }).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No contractor invoices</strong>Invoices submitted by approved contractors will appear here.</div>`}</section>`;
}

function pricingRateInput(name, rate = "") {
  return `<input class="form-input" type="number" min="0" step="0.01" name="${escapeHtml(name)}" value="${rate === "" ? "" : Number(rate)}" placeholder="0.00">`;
}

function updateContractorPricingPreview() {
  const form = document.getElementById("modal-form");
  const preview = document.getElementById("contractor-pricing-preview");
  if (!form || !preview || form.dataset.kind !== "new-contractor-submission") return;
  const data = new FormData(form);
  const company = contractorById(String(data.get("contractorId") || ""));
  if (!company) {
    preview.textContent = "Select a company to see its configured rates.";
    return;
  }
  const role = String(data.get("role") || "");
  const equipmentType = String(data.get("equipmentType") || "");
  const hours = Number(data.get("hours") || 0);
  const quantity = Number(data.get("equipmentQuantity") || 0);
  const rentalDays = Number(data.get("equipmentDays") || 0);
  const laborRate = Number(company.pricing?.laborRates?.[role] || 0);
  const equipmentRate = Number(company.pricing?.equipmentRates?.[equipmentType] || 0);
  const estimate = hours * laborRate + quantity * rentalDays * equipmentRate;
  const laborText = role ? `${role}: ${laborRate > 0 ? `${money(laborRate)}/hr` : "no rate configured"}` : "No labor selected";
  const equipmentText = equipmentType ? `${equipmentType}: ${equipmentRate > 0 ? `${money(equipmentRate)}/unit/day` : "no rate configured"}` : "No equipment selected";
  preview.textContent = `${company.name} rates · ${laborText} · ${equipmentText} · Estimated total ${money(estimate)}`;
}

function contractorInvoiceEquipmentFields(jobId) {
  const assignedIds = new Set(contractorWorkflow.jobEquipment
    .filter((item) => item.job_id === jobId)
    .map((item) => item.equipment_id));
  const assets = contractorWorkflow.equipment.filter((asset) => asset.active && assignedIds.has(asset.id));
  return assets.length
    ? assets.map((asset) => `<label class="contractor-equipment-choice"><span><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(asset.equipment_type)} · ${escapeHtml(asset.serial_number)}</small></span><input type="number" min="0" step="0.5" name="equipmentDays_${escapeHtml(asset.id)}" placeholder="Days" aria-label="${escapeHtml(asset.name)} rental days"></label>`).join("")
    : `<p class="form-hint">No equipment is assigned to this job.</p>`;
}

function refreshContractorInvoiceEquipment(jobId) {
  const container = document.getElementById("contractor-invoice-equipment");
  if (container) container.innerHTML = contractorInvoiceEquipmentFields(jobId);
}

function safetyTemplatesForJob(jobId = "") {
  return (state.safetyTemplates || []).filter((template) => !template.jobId || template.jobId === jobId);
}

const HAZARD_LIBRARY = [
  { id: "h2s", name: "H2S / sour gas", category: "Hazardous atmosphere", keywords: ["h2s", "hydrogen sulphide", "hydrogen sulfide", "sour gas"], mitigation: "Wear gas monitors with alarms set, keep escape breathing apparatus available, confirm upwind muster point, and stop work on alarm.", section: "Gas monitors, alarms, and upwind muster confirmed" },
  { id: "confined", name: "Confined space entry", category: "Confined space", keywords: ["confined space", "tank entry", "vessel entry", "silo entry"], mitigation: "Complete entry permit, continuous gas monitoring, attendant, rescue plan, and communication before entry.", section: "Confined space permit, gas monitoring, and rescue plan confirmed" },
  { id: "excavation", name: "Excavation / trenching", category: "Ground disturbance", keywords: ["excavation", "trench", "ground disturbance", "dig", "digging"], mitigation: "Complete locates, assess soil, use shoring/sloping, provide access/egress, and barricade the excavation.", section: "Locates, shoring, and access/egress confirmed" },
  { id: "lifting", name: "Lifting & rigging", category: "Lifting", keywords: ["crane", "rigging", "sling", "hoist", "lift plan"], mitigation: "Review the lift plan, inspect rigging, set the exclusion zone, and confirm a certified operator and signal person.", section: "Lift plan, rigging inspection, and exclusion zone confirmed" },
  { id: "isolation", name: "Energy isolation / LOTO", category: "Energy isolation", keywords: ["lockout", "tagout", "loto", "isolation", "de-energize", "de-energise"], mitigation: "Identify and lock out isolation points, release stored energy, and verify with a try-out.", section: "Isolations locked out and stored energy released" },
  { id: "pressure", name: "Pressure / pipeline test", category: "Pressure", keywords: ["pressure test", "hydrostatic", "hydro test", "pipeline pressure", "pig run", "pigging"], mitigation: "Set test boundaries and exclusion zone, use rated equipment, monitor pressure, and maintain communication.", section: "Pressure test boundaries and exclusion zone confirmed" },
  { id: "electrical", name: "Electrical", category: "Electrical", keywords: ["electrical", "electric", "energized", "energised", "switchgear", "arc flash"], mitigation: "Identify circuits, use GFCI/assured grounding, confirm qualified workers, and maintain approach limits.", section: "Electrical hazards and approach limits confirmed" },
  { id: "overhead", name: "Overhead power lines", category: "Electrical", keywords: ["overhead line", "power line", "high voltage", "high-voltage"], mitigation: "Confirm clearance distances, assign a spotter, and lower equipment or isolate lines.", section: "Overhead line clearance and spotter confirmed" },
  { id: "traffic", name: "Traffic & mobile equipment", category: "Traffic", keywords: ["traffic", "vehicle", "mobile equipment", "excavator", "backhoe", "blind spot", "spotter"], mitigation: "Use a traffic control plan, signage, spotters, high-visibility PPE, and defined pedestrian routes.", section: "Traffic control plan and spotters in place" },
  { id: "driving", name: "Driving / journey management", category: "Driving", keywords: ["driving", "journey management", "highway", "road conditions"], mitigation: "Complete a journey plan, check weather and roads, use seat belts, take rest breaks, and avoid distractions.", section: "Journey management plan reviewed" },
  { id: "chemical", name: "Chemical exposure", category: "Chemicals", keywords: ["chemical", "sds", "msds", "solvent", "acid", "caustic", "spill"], mitigation: "Review SDS, provide ventilation and PPE, keep a spill kit and eyewash, and confirm handling procedures.", section: "SDS reviewed and spill response ready" },
  { id: "fire", name: "Fire / hot work", category: "Fire", keywords: ["hot work", "welding", "cutting", "grinder spark", "fire watch", "flammable"], mitigation: "Obtain a hot work permit, assign a fire watch, provide an extinguisher, maintain 15 m clearance, and gas test.", section: "Hot work permit and fire watch in place" },
  { id: "weather", name: "Weather extremes", category: "Weather", keywords: ["heat stress", "cold stress", "hypothermia", "heat exhaustion", "lightning", "high wind", "wind chill"], mitigation: "Monitor the forecast, set work/rest cycles, provide hydration and shelter, and apply stop-work thresholds.", section: "Weather forecast and work/rest plan reviewed" },
  { id: "wildlife", name: "Wildlife", category: "Wildlife", keywords: ["wildlife", "bear", "cougar", "wolf", "snake", "wasp", "tick"], mitigation: "Maintain a wildlife watch, carry bear spray or an air horn, travel in pairs, and follow the reporting procedure.", section: "Wildlife watch and deterrents ready" },
  { id: "noise", name: "Noise", category: "Noise", keywords: ["noise", "hearing", "decibel"], mitigation: "Wear hearing protection, apply noise controls, and agree on communication signals.", section: "Hearing protection and communication signals confirmed" },
  { id: "vibration", name: "Hand-arm vibration", category: "Vibration", keywords: ["vibration", "vibrating tool"], mitigation: "Use low-vibration tools, rotate tasks, warm up, and follow exposure limits.", section: "Vibration exposure and task rotation reviewed" },
  { id: "repetitive", name: "Repetitive work / strain", category: "Ergonomics & repetitive work", keywords: ["repetitive", "repetition", "ergonomic", "strain", "carpal", "tendonitis", "tendinitis"], mitigation: "Rotate tasks, schedule micro-breaks, adjust tools and workstations, and report early symptoms.", section: "Task rotation and micro-breaks planned" },
  { id: "manual", name: "Manual handling", category: "Ergonomics & repetitive work", keywords: ["manual lifting", "heavy lifting", "lifting", "back injury", "two-person lift"], mitigation: "Use mechanical aids or a team lift, keep loads close, and follow safe lifting technique.", section: "Mechanical aids or team lift arranged" },
  { id: "heights", name: "Working at heights", category: "Working at heights", keywords: ["heights", "ladder", "scaffold", "fall arrest", "fall protection", "elevated platform"], mitigation: "Use guardrails or fall arrest, inspect equipment, confirm anchors, and have a rescue plan.", section: "Fall protection and rescue plan confirmed" },
  { id: "slips", name: "Slips, trips & falls", category: "Slips and trips", keywords: ["slip", "trip", "uneven ground", "mud", "snow", "ice", "rain"], mitigation: "Maintain housekeeping, use matting, wear suitable footwear, improve lighting, and maintain walkways.", section: "Walkways, lighting, and housekeeping checked" },
  { id: "linefire", name: "Line of fire", category: "Line of fire", keywords: ["line of fire", "struck by", "swing radius", "pinch", "crush"], mitigation: "Set exclusion zones, use spotters, maintain communication, and keep body positioning away from moving parts.", section: "Exclusion zones and spotter communication confirmed" },
  { id: "tools", name: "Hand & power tools", category: "Tools", keywords: ["hand tool", "power tool", "grinder", "saw", "impact wrench"], mitigation: "Inspect tools, keep guards in place, use the correct tool for the task, and wear PPE.", section: "Tools inspected and guards in place" },
  { id: "housekeeping", name: "Housekeeping & materials", category: "Housekeeping", keywords: ["housekeeping", "debris", "material storage", "trip hazard", "waste"], mitigation: "Keep the work area clean, secure materials, remove waste, and keep walkways clear.", section: "Work area housekeeping confirmed" },
  { id: "dust", name: "Dust / silica", category: "Hazardous atmosphere", keywords: ["dust", "silica", "particulate"], mitigation: "Apply dust suppression, use respiratory protection, and monitor exposure.", section: "Dust controls and respiratory protection confirmed" },
  { id: "fatigue", name: "Fatigue", category: "Fatigue", keywords: ["fatigue", "long shift", "overtime", "drowsy"], mitigation: "Set shift limits and rest breaks, use buddy checks, and confirm fit for duty.", section: "Fit for duty and shift limits confirmed" },
  { id: "public", name: "Public / third-party exposure", category: "Public", keywords: ["public", "third party", "landowner", "resident", "visitor"], mitigation: "Secure the area, use signage, communicate with the landowner, and escort visitors.", section: "Public/third-party area secured" },
];

const JSA_SECTION_RULES = [
  { pattern: /(scope|objective|task description|work plan)/i, label: "Scope and task steps reviewed", type: "yesno" },
  { pattern: /(ppe|personal protective)/i, label: "PPE requirements reviewed", type: "checkbox" },
  { pattern: /(permit|isolation|loto|lockout|tagout)/i, label: "Permits and isolations in place", type: "yesno" },
  { pattern: /(emergency|muster|rescue|evacuation)/i, label: "Emergency response and muster point reviewed", type: "yesno" },
  { pattern: /(environment|spill|wildlife|weather)/i, label: "Environmental and weather controls reviewed", type: "yesno" },
  { pattern: /(sign[- ]?off|signature|attendee|attendance|crew)/i, label: "Crew attendance and sign-off", type: "checkbox" },
];

let jsaAnalysisState = null;
let pdfFormFieldSuggestions = [];

function analyzeJSAText(text) {
  const normalized = String(text || "").toLowerCase();
  const hazards = HAZARD_LIBRARY
    .filter((entry) => entry.keywords.some((keyword) => normalized.includes(keyword)))
    .map((entry) => ({ id: entry.id, name: entry.name, mitigation: entry.mitigation, category: entry.category }));
  const sections = [];
  const addSection = (label, type = "yesno") => {
    if (label && !sections.some((section) => section.label === label)) sections.push({ id: uid(), label, type });
  };
  addSection("Crew fit for duty and PPE inspected", "checkbox");
  addSection("Emergency response and muster point reviewed", "yesno");
  hazards.forEach((hazard) => {
    const entry = HAZARD_LIBRARY.find((item) => item.id === hazard.id);
    if (entry?.section) addSection(entry.section, "yesno");
  });
  JSA_SECTION_RULES.forEach((rule) => {
    if (rule.pattern.test(normalized)) addSection(rule.label, rule.type);
  });
  if (hazards.length) addSection("Hazards identified and controls agreed with the crew", "yesno");
  return { hazards, sections };
}

function extractPdfText(file) {
  return new Promise((resolve, reject) => {
    if (!window.pdfjsLib) {
      reject(new Error("PDF analysis is unavailable. Paste the JSA text instead."));
      return;
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    file.arrayBuffer()
      .then((buffer) => window.pdfjsLib.getDocument({ data: buffer }).promise)
      .then(async (pdf) => {
        const pages = [];
        for (let index = 1; index <= pdf.numPages; index += 1) {
          const page = await pdf.getPage(index);
          const content = await page.getTextContent();
          const items = content.items
            .filter((item) => typeof item.str === "string" && item.str.trim())
            .map((item) => ({
              text: item.str.trim(),
              x: Number(item.transform?.[4]) || 0,
              y: Number(item.transform?.[5]) || 0,
            }))
            .sort((first, second) => second.y - first.y || first.x - second.x);
          const lines = [];
          items.forEach((item) => {
            let line = lines[lines.length - 1];
            if (!line || Math.abs(line.y - item.y) > 3) {
              line = { y: item.y, items: [] };
              lines.push(line);
            }
            line.items.push(item);
          });
          pages.push(lines.map((line) => line.items.map((item) => item.text).join(" ")).join("\n"));
        }
        resolve(pages.join("\n"));
      })
      .catch((error) => reject(error));
  });
}

function pdfFormFieldType(label) {
  const normalized = label.toLowerCase();
  if (/\b(description|explain|comments?|remarks?|notes?|details|observations?)\b/.test(normalized) || label.length > 90) return "textarea";
  if (/\b(date|when)\b/.test(normalized)) return "date";
  if (/\b(how many|quantity|hours|count|temperature|pressure|distance|measurement)\b/.test(normalized)) return "number";
  if (/^(is|are|was|were|has|have|had|does|do|did|can|could|will|would|should)\b/.test(normalized)
    || /\b(yes\s*\/\s*no|yes or no|check(ed)?|inspect(ed|ion)?|confirm(ed|ation)?|complete(d)?|verified)\b/.test(normalized)) return "yesno";
  if (/\b(attendee|attendance|acknowledg(e|ment))\b/.test(normalized)) return "checkbox";
  return "text";
}

function extractPdfFormFields(text) {
  const ignoredLines = new Set(["form", "checklist", "inspection", "yes no n/a", "yes / no / n/a"]);
  const seen = new Set();
  return String(text || "").split(/\r?\n/)
    .map((line) => {
      const isNumberedPrompt = /^\s*\d{1,3}\s*[.)]\s*/.test(line);
      const isMarkedPrompt = /^\s*[□☐☑✓✔•*▪-]/.test(line);
      const hasBlank = /_{2,}|\.{3,}/.test(line);
      const isColonLabel = /:\s*$/.test(line);
      const label = line
        .replace(/^\s*(?:\d{1,3}\s*[.)]\s*)?[\s□☐☑✓✔•*▪\-]+/, "")
        .replace(/^\s*\d{1,3}\s*[.)]\s*/, "")
        .replace(/\s*(?:_{2,}|\.{3,})\s*$/, "")
        .replace(/\s+(?:□|☐|☑|☒)\s*$/, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[:;]\s*$/, "")
        .trim();
      return { label, isNumberedPrompt, isMarkedPrompt, hasBlank, isColonLabel };
    })
    .filter(({ label, isNumberedPrompt, isMarkedPrompt, hasBlank, isColonLabel }) => {
      const normalized = label.toLowerCase();
      if (label.length < 3 || label.length > 160 || ignoredLines.has(normalized) || seen.has(normalized)) return false;
      const isQuestion = label.includes("?");
      const isNamedField = /^(name|date|time|job|project|location|site|company|client|employee|supervisor|foreman|signature|phone|email|address|permit|weather|temperature|equipment|serial number|work performed|hazards|controls|comments|notes|description)\b/i.test(label);
      const isLongParagraph = label.length > 110 && !isQuestion;
      if (isLongParagraph || !(isQuestion || isNumberedPrompt || isMarkedPrompt || isNamedField || hasBlank || isColonLabel)) return false;
      seen.add(normalized);
      return true;
    })
    .map(({ label }) => ({ id: uid(), label, type: pdfFormFieldType(label), required: true }));
}

function renderPdfFormImportResults(fields) {
  const container = document.getElementById("pdf-form-import-results");
  if (!container) return;
  if (!fields.length) {
    container.innerHTML = `<div class="empty-state"><strong>No form questions found</strong>This PDF may be scanned or image-only. Use a text-based PDF or add form items manually.</div>`;
    return;
  }
  container.innerHTML = `<div class="jsa-results-head"><strong>Review imported fields</strong><span>${fields.length} suggestion${fields.length === 1 ? "" : "s"} · edit fields after adding</span></div>
    <div class="jsa-result-group">${fields.map((field) => `<label class="jsa-result-item"><input type="checkbox" data-pdf-form-field="${escapeHtml(field.id)}" checked><span>${escapeHtml(field.label)} <b>· ${escapeHtml(field.type)}</b></span></label>`).join("")}</div>
    <button type="button" class="button button-primary" data-action="add-pdf-form-fields">Add selected fields</button>`;
}

async function importPdfFormFromModal() {
  const file = document.getElementById("pdf-form-file")?.files?.[0];
  if (!file) {
    showToast("Choose a PDF form to import.");
    return;
  }
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    showToast("Choose a PDF file.");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast("PDF forms must be 10 MB or smaller.");
    return;
  }
  pdfFormFieldSuggestions = [];
  document.getElementById("pdf-form-import-results").innerHTML = "";
  try {
    const text = await extractPdfText(file);
    pdfFormFieldSuggestions = extractPdfFormFields(text);
    const nameInput = document.querySelector('#modal-form[data-kind="safety-template"] input[name="name"]');
    if (nameInput && !nameInput.value.trim()) nameInput.value = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
    renderPdfFormImportResults(pdfFormFieldSuggestions);
    showToast(pdfFormFieldSuggestions.length
      ? `Found ${pdfFormFieldSuggestions.length} possible form field${pdfFormFieldSuggestions.length === 1 ? "" : "s"}. Review before adding.`
      : "No selectable text fields found. Scanned PDFs need OCR before import.");
  } catch (error) {
    console.error("Could not import the PDF form.", error);
    showToast("Could not read this PDF. Try another PDF or add the form items manually.");
  }
}

function applyPdfFormFieldSuggestions() {
  const fieldList = document.getElementById("template-field-list");
  if (!fieldList) return;
  const selectedFields = [...document.querySelectorAll("[data-pdf-form-field]:checked")]
    .map((checkbox) => pdfFormFieldSuggestions.find((field) => field.id === checkbox.dataset.pdfFormField))
    .filter(Boolean);
  let added = 0;
  selectedFields.forEach((field) => {
    const exists = [...fieldList.querySelectorAll("[data-template-field]")]
      .some((row) => row.querySelector("[data-field-label]").value.trim().toLowerCase() === field.label.toLowerCase());
    if (exists) return;
    fieldList.insertAdjacentHTML("beforeend", renderTemplateFieldRow(field));
    added += 1;
  });
  showToast(added ? `Added ${added} field${added === 1 ? "" : "s"}. Review them and save the form.` : "No new fields selected.");
}

function renderTemplateHazardRow(hazard = {}) {
  return `<div class="template-hazard-row" data-template-hazard data-hazard-id="${escapeHtml(hazard.id || uid())}">
    <input class="form-input" data-hazard-name placeholder="Hazard" value="${escapeHtml(hazard.name || "")}">
    <input class="form-input" data-hazard-mitigation placeholder="Control / mitigation" value="${escapeHtml(hazard.mitigation || "")}">
    <button type="button" class="text-link foreman-danger-link" data-remove-template-hazard>Remove</button>
  </div>`;
}

function templateHazardRows() {
  return [...document.querySelectorAll("#template-hazard-list [data-template-hazard]")];
}

function addTemplateHazard(hazard) {
  const list = document.getElementById("template-hazard-list");
  if (!list) return false;
  const name = String(hazard.name || "").trim();
  if (!name) return false;
  const exists = templateHazardRows().some((row) => row.querySelector("[data-hazard-name]").value.trim().toLowerCase() === name.toLowerCase());
  if (exists) return false;
  list.insertAdjacentHTML("beforeend", renderTemplateHazardRow({ ...hazard, id: hazard.id || uid() }));
  return true;
}

function renderJsaAnalysisResults(analysis) {
  const container = document.getElementById("jsa-analysis-results");
  if (!container) return;
  const hasResults = analysis.hazards.length || analysis.sections.length;
  container.innerHTML = `<div class="jsa-results-head"><strong>Suggestions from the JSA</strong><span>${analysis.hazards.length} hazard${analysis.hazards.length === 1 ? "" : "s"} · ${analysis.sections.length} section${analysis.sections.length === 1 ? "" : "s"}</span></div>
    ${analysis.sections.length ? `<div class="jsa-result-group"><strong>Sections</strong>${analysis.sections.map((section) => `<label class="jsa-result-item"><input type="checkbox" data-jsa-section="${escapeHtml(section.id)}" checked><span>${escapeHtml(section.label)}</span></label>`).join("")}</div>` : ""}
    ${analysis.hazards.length ? `<div class="jsa-result-group"><strong>Hazards & mitigations</strong>${analysis.hazards.map((hazard) => `<label class="jsa-result-item"><input type="checkbox" data-jsa-hazard="${escapeHtml(hazard.id)}" checked><span><b>${escapeHtml(hazard.name)}</b> — ${escapeHtml(hazard.mitigation)}</span></label>`).join("")}</div>` : ""}
    ${hasResults ? `<button type="button" class="button button-primary" data-action="add-jsa-suggestions">Add selected to form</button>` : `<div class="empty-state"><strong>No known hazards detected</strong>Add hazards manually or paste more JSA detail.</div>`}`;
}

async function analyzeJsaFromModal() {
  const file = document.getElementById("jsa-file")?.files?.[0];
  const pasted = String(document.getElementById("jsa-text")?.value || "").trim();
  let text = pasted;
  if (!text && file) {
    try {
      text = await extractPdfText(file);
    } catch (error) {
      console.error("Could not read the JSA PDF.", error);
      showToast(error.message || "Could not read that PDF. Paste the JSA text instead.");
      return;
    }
  }
  if (!text) {
    showToast("Upload a JSA PDF or paste the JSA text to analyze.");
    return;
  }
  jsaAnalysisState = analyzeJSAText(text);
  renderJsaAnalysisResults(jsaAnalysisState);
  showToast(`JSA analyzed: ${jsaAnalysisState.hazards.length} hazard(s), ${jsaAnalysisState.sections.length} suggested section(s).`);
}

function applyJsaSuggestions() {
  if (!jsaAnalysisState) return;
  const selectedSections = [...document.querySelectorAll("[data-jsa-section]:checked")]
    .map((checkbox) => jsaAnalysisState.sections.find((section) => section.id === checkbox.dataset.jsaSection))
    .filter(Boolean);
  const selectedHazards = [...document.querySelectorAll("[data-jsa-hazard]:checked")]
    .map((checkbox) => jsaAnalysisState.hazards.find((hazard) => hazard.id === checkbox.dataset.jsaHazard))
    .filter(Boolean);
  const fieldList = document.getElementById("template-field-list");
  let addedSections = 0;
  selectedSections.forEach((section) => {
    if (!fieldList) return;
    const exists = [...fieldList.querySelectorAll("[data-template-field]")]
      .some((row) => row.querySelector("[data-field-label]").value.trim().toLowerCase() === section.label.toLowerCase());
    if (exists) return;
    fieldList.insertAdjacentHTML("beforeend", renderTemplateFieldRow({ id: section.id, label: section.label, type: section.type, required: true }));
    addedSections += 1;
  });
  let addedHazards = 0;
  selectedHazards.forEach((hazard) => {
    if (addTemplateHazard(hazard)) addedHazards += 1;
  });
  showToast(`Added ${addedSections} section(s) and ${addedHazards} hazard(s) to the form.`);
}

function renderTemplateFieldRow(item = {}) {
  const types = [["yesno", "Yes / No"], ["checkbox", "Confirmation"], ["text", "Short text"], ["textarea", "Long text"], ["number", "Number"], ["date", "Date"]];
  return `<div class="template-field-row" data-template-field data-field-id="${escapeHtml(item.id || uid())}">
    <input class="form-input" data-field-label placeholder="Question or inspection item" value="${escapeHtml(item.label || "")}">
    <select class="form-input" data-field-type>${types.map(([value, label]) => `<option value="${value}" ${item.type === value ? "selected" : ""}>${label}</option>`).join("")}</select>
    <label class="template-field-required"><input type="checkbox" data-field-required ${item.required !== false ? "checked" : ""}><span>Required</span></label>
    <button type="button" class="text-link foreman-danger-link" data-remove-template-field>Remove</button>
  </div>`;
}

function renderSafetyTemplatesSection() {
  const templates = state.safetyTemplates || [];
  return `<section class="card panel safety-template-panel"><div class="panel-head"><div><h2 class="panel-title">Custom safety forms</h2><p class="panel-subtitle">Build a form once, fill it out on a phone or tablet, and collect crew signatures.</p></div><button class="button button-outline" data-action="safety-template-new"><span>+</span>New form</button></div>
    ${templates.length ? `<div class="safety-template-grid">${templates.map((template) => {
      const job = template.jobId ? jobById(template.jobId) : null;
      return `<article class="safety-template-card"><div class="safety-template-head"><div><strong>${escapeHtml(template.name)}</strong><span>${job ? escapeHtml(job.name) : "All jobs"} · ${template.fields.length} item${template.fields.length === 1 ? "" : "s"} · ${(template.hazards || []).length} hazard${(template.hazards || []).length === 1 ? "" : "s"}</span></div><button class="text-link" data-action="safety-template-edit" data-template-id="${escapeHtml(template.id)}">Edit</button></div>${template.description ? `<p>${escapeHtml(template.description)}</p>` : ""}<div class="safety-template-actions"><button class="button button-primary" data-fill-template="${escapeHtml(template.id)}" ${template.jobId ? `data-job-id="${escapeHtml(template.jobId)}"` : ""}>Fill out</button><button class="text-link foreman-danger-link" data-delete-template="${escapeHtml(template.id)}">Delete</button></div></article>`;
    }).join("")}</div>` : `<div class="empty-state"><strong>No custom forms yet</strong>Create a safety form with your own questions, then crew can sign it on a tablet or phone.</div>`}</section>`;
}

function startSafetyForm(templateId, jobId, workDate = dateOffset(0)) {
  const template = (state.safetyTemplates || []).find((item) => item.id === templateId);
  const job = jobById(jobId);
  if (!template || !job) {
    showToast("Choose a valid safety form and job.");
    return;
  }
  safetyFormDraft = { templateId, jobId, workDate, signatures: [], extraHazards: [] };
  setPage("safety-fill");
  showToast("Fill in the form and collect crew signatures.");
}

function safetyDraftHazards(template = null) {
  const resolved = template || (state.safetyTemplates || []).find((item) => item.id === safetyFormDraft?.templateId);
  return [...(resolved?.hazards || []), ...(safetyFormDraft?.extraHazards || [])];
}

function renderSafetyHazardList() {
  const hazards = safetyDraftHazards();
  if (!hazards.length) return `<p class="foreman-note">No hazards listed yet. Add a library hazard or a custom hazard below.</p>`;
  return hazards.map((hazard) => `<label class="safety-hazard-item"><input type="checkbox" name="hazard_${escapeHtml(hazard.id)}" data-hazard-check><div><strong>${escapeHtml(hazard.name)}</strong><span>${escapeHtml(hazard.mitigation || "No mitigation recorded")}</span></div><span class="status-pill">Control</span></label>`).join("");
}

function refreshSafetyHazardList() {
  const container = document.getElementById("safety-hazard-list");
  if (!container) return;
  const checked = new Set([...container.querySelectorAll("[data-hazard-check]:checked")].map((input) => input.name));
  container.innerHTML = renderSafetyHazardList();
  checked.forEach((name) => {
    const input = container.querySelector(`input[name="${name}"]`);
    if (input) input.checked = true;
  });
}

function addDraftHazard(hazard) {
  if (!safetyFormDraft) return false;
  const name = String(hazard.name || "").trim();
  if (!name) return false;
  if (safetyDraftHazards().some((item) => item.name.toLowerCase() === name.toLowerCase())) return false;
  safetyFormDraft.extraHazards.push({ ...hazard, id: hazard.id || uid() });
  refreshSafetyHazardList();
  return true;
}

function repeatRecentHazards(target) {
  const jobIdValue = target === "template"
    ? (document.getElementById("modal-form")?.elements?.jobId?.value || "")
    : (safetyFormDraft?.jobId || "");
  const candidates = state.safety.filter((form) => (form.hazards || []).length && (!jobIdValue || form.jobId === jobIdValue));
  const latest = candidates.sort((first, second) => String(second.updated || "").localeCompare(String(first.updated || "")))[0]
    || state.safety.find((form) => (form.hazards || []).length);
  if (!latest) {
    showToast("No previous hazards found to repeat.");
    return;
  }
  let added = 0;
  latest.hazards.forEach((hazard) => {
    if (target === "template") {
      if (addTemplateHazard(hazard)) added += 1;
    } else if (addDraftHazard(hazard)) {
      added += 1;
    }
  });
  showToast(added ? `Repeated ${added} hazard${added === 1 ? "" : "s"} from ${latest.title}.` : "Those hazards are already on the form.");
}

function safetyFieldInput(field) {
  const name = `field_${field.id}`;
  const required = field.required ? "required" : "";
  const requiredMark = field.required ? `<span class="safety-required">Required</span>` : "";
  let input = "";
  if (field.type === "yesno") input = `<div class="safety-radio-row"><label><input type="radio" name="${name}" value="Yes" ${required}><span>Yes</span></label><label><input type="radio" name="${name}" value="No" ${required}><span>No</span></label></div>`;
  else if (field.type === "checkbox") input = `<label class="safety-confirm"><input type="checkbox" name="${name}" value="Yes" ${required}><span>Confirmed</span></label>`;
  else if (field.type === "textarea") input = `<textarea class="form-textarea" name="${name}" rows="3" ${required}></textarea>`;
  else if (field.type === "number") input = `<input class="form-input" type="number" step="any" name="${name}" ${required}>`;
  else if (field.type === "date") input = `<input class="form-input" type="date" name="${name}" value="${dateOffset(0)}" ${required}>`;
  else input = `<input class="form-input" type="text" name="${name}" ${required}>`;
  return `<div class="safety-fill-field"><label>${escapeHtml(field.label)}${requiredMark}</label>${input}</div>`;
}

function renderSignatureEntries() {
  const signatures = safetyFormDraft?.signatures || [];
  if (!signatures.length) return `<div class="empty-state"><strong>No signatures yet</strong>Add each crew member's signature before saving.</div>`;
  return signatures.map((signature, index) => `<div class="signature-entry"><img src="${signature.dataUrl}" alt="Signature of ${escapeHtml(signature.name)}"><div class="signature-meta"><strong>${escapeHtml(signature.name)}</strong><span>${escapeHtml(signature.role || "Crew member")} · ${escapeHtml(new Date(signature.signedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span></div><button type="button" class="text-link foreman-danger-link" data-remove-signature="${index}">Remove</button></div>`).join("");
}

function renderSafetyFill() {
  const template = (state.safetyTemplates || []).find((item) => item.id === safetyFormDraft?.templateId);
  const job = jobById(safetyFormDraft?.jobId || "");
  if (!template || !job) {
    return `${heading("FIELD SAFETY", "Safety form", "Choose a form and job from the Safety & JSA page to get started.")}<section class="card panel"><div class="empty-state"><strong>No form selected</strong><button class="button button-primary" data-page="safety">Back to safety forms</button></div></section>`;
  }
  const crew = foremanJobCrew(job);
  return `${heading("FIELD SAFETY", escapeHtml(template.name), `${escapeHtml(job.name)} · ${formatDate(safetyFormDraft.workDate)} · ${template.fields.length} item${template.fields.length === 1 ? "" : "s"}`, `<button class="button button-outline" data-page="safety"><span>←</span>Cancel</button>`)}
    <form id="safety-fill-form" class="safety-fill">
      <section class="card panel safety-fill-card">
        <div class="panel-head"><div><h2 class="panel-title">${escapeHtml(template.name)}</h2><p class="panel-subtitle">${escapeHtml(template.description || "Complete every item, then collect crew signatures below.")}</p></div>${statusPill("Draft")}</div>
        <div class="safety-fill-fields">${template.fields.map(safetyFieldInput).join("")}</div>
        <div class="safety-hazard-review">
          <div class="panel-head" style="margin:6px 0 8px"><div><h3 class="panel-title">Hazards &amp; controls</h3><p class="panel-subtitle">Review each hazard and control with the crew, then confirm it.</p></div><span class="status-pill">${safetyDraftHazards().length} listed</span></div>
          <div id="safety-hazard-list" class="safety-hazard-list">${renderSafetyHazardList()}</div>
          <div class="safety-hazard-tools">
            <div class="safety-hazard-tool-row">
              <select class="form-input" id="fill-hazard-library"><option value="">Add a hazard from the library</option>${HAZARD_LIBRARY.map((hazard) => `<option value="${escapeHtml(hazard.id)}">${escapeHtml(hazard.category)} · ${escapeHtml(hazard.name)}</option>`).join("")}</select>
              <button type="button" class="button button-outline" data-action="add-fill-hazard">Add hazard</button>
              <button type="button" class="text-link" data-action="repeat-fill-hazards">Repeat recent</button>
            </div>
            <div class="safety-hazard-tool-row">
              <input class="form-input" id="fill-hazard-name" placeholder="Custom hazard">
              <input class="form-input" id="fill-hazard-mitigation" placeholder="Control / mitigation">
              <button type="button" class="button button-outline" data-action="add-fill-custom-hazard">Add custom</button>
            </div>
          </div>
        </div>
      </section>
      <section class="card panel safety-signoff-card">
        <div class="panel-head"><div><h2 class="panel-title">Crew sign-off</h2><p class="panel-subtitle">Each crew member signs with a finger or stylus. Signatures are saved with the form.</p></div><span class="status-pill" id="signature-count">${safetyFormDraft.signatures.length} signed</span></div>
        <div class="signature-grid">
          <div class="signature-controls">
            <label class="safety-fill-field"><span>Who is signing?</span><select class="form-input" id="signature-name"><option value="">Select a crew member</option>${crew.map((person) => `<option value="${escapeHtml(person.name)}">${escapeHtml(person.name)} · ${escapeHtml(person.role)}</option>`).join("")}<option value="__other">Other (type a name)</option></select></label>
            <label class="safety-fill-field hidden" id="signature-custom-wrap"><span>Name</span><input class="form-input" id="signature-custom-name" placeholder="Crew member or visitor name"></label>
            <label class="safety-fill-field"><span>Role / company</span><input class="form-input" id="signature-role" placeholder="Crew member" value="Crew member"></label>
            <div class="signature-pad-label"><span>Signature</span><small>Use a finger, stylus, or mouse</small></div>
            <div class="signature-pad-wrap"><canvas id="signature-pad"></canvas></div>
            <div class="signature-actions"><button type="button" class="button button-outline" data-action="clear-signature">Clear</button><button type="button" class="button button-primary" data-action="add-signature">Add signature</button></div>
          </div>
          <div class="signature-list" id="signature-list">${renderSignatureEntries()}</div>
        </div>
      </section>
      <div class="safety-fill-actions"><button type="button" class="button button-outline" data-page="safety">Cancel</button><button type="submit" class="button button-primary" name="saveAction" value="save">Save signed form</button><button type="submit" class="button button-outline" name="saveAction" value="print">Save &amp; print PDF</button></div>
    </form>
    ${printingSafetyRecordId ? renderSafetyPrintSheet() : ""}`;
}

function mountSafetySignaturePad() {
  const canvas = document.getElementById("signature-pad");
  if (!canvas) return;
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const bounds = canvas.getBoundingClientRect();
  canvas.width = Math.max(Math.round(bounds.width), 320) * ratio;
  canvas.height = Math.max(Math.round(bounds.height), 170) * ratio;
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  context.lineWidth = 2.2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#172b2a";
  let drawing = false;
  let dirty = false;
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    drawing = true;
    dirty = true;
    canvas.setPointerCapture(event.pointerId);
    const position = point(event);
    context.beginPath();
    context.moveTo(position.x, position.y);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    event.preventDefault();
    const position = point(event);
    context.lineTo(position.x, position.y);
    context.stroke();
  });
  const finish = () => { drawing = false; };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  canvas.addEventListener("pointerleave", finish);
  signaturePad = {
    canvas,
    isDirty: () => dirty,
    clear: () => {
      context.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
      dirty = false;
    },
  };
}

function refreshSafetySignatureList() {
  const list = document.getElementById("signature-list");
  if (list) list.innerHTML = renderSignatureEntries();
  const count = document.getElementById("signature-count");
  if (count) count.textContent = `${safetyFormDraft.signatures.length} signed`;
}

function addSafetySignature() {
  if (!signaturePad) return;
  const select = document.getElementById("signature-name");
  const name = select?.value === "__other"
    ? (document.getElementById("signature-custom-name")?.value || "").trim()
    : select?.value || "";
  if (!name) {
    showToast("Choose or enter the crew member signing.");
    return;
  }
  if (!signaturePad.isDirty()) {
    showToast("Sign in the signature pad first.");
    return;
  }
  const role = (document.getElementById("signature-role")?.value || "").trim() || "Crew member";
  safetyFormDraft.signatures.push({ name, role, signedAt: new Date().toISOString(), dataUrl: signaturePad.canvas.toDataURL("image/png") });
  signaturePad.clear();
  refreshSafetySignatureList();
  showToast(`${name} signed the form.`);
}

function safetyAnswerValue(form, field) {
  const name = `field_${field.id}`;
  if (field.type === "yesno") return form.querySelector(`input[name="${name}"]:checked`)?.value || "";
  if (field.type === "checkbox") return form.elements[name]?.checked ? "Yes" : "No";
  return String(form.elements[name]?.value || "").trim();
}

function saveSafetyForm(form, printAfter) {
  const template = (state.safetyTemplates || []).find((item) => item.id === safetyFormDraft?.templateId);
  const job = jobById(safetyFormDraft?.jobId || "");
  if (!template || !job) {
    showToast("This safety form is no longer available.");
    setPage("safety");
    return;
  }
  const missing = template.fields.find((field) => {
    if (!field.required) return false;
    if (field.type === "checkbox") return form.elements[`field_${field.id}`]?.checked !== true;
    return !safetyAnswerValue(form, field);
  });
  if (missing) {
    showToast(`Complete “${missing.label}” before saving.`);
    return;
  }
  if (!safetyFormDraft.signatures.length) {
    showToast("Collect at least one crew signature before saving.");
    return;
  }
  const hazards = safetyDraftHazards(template).map((hazard) => ({
    id: hazard.id, name: hazard.name, mitigation: hazard.mitigation || "",
    reviewed: form.elements[`hazard_${hazard.id}`]?.checked === true,
  }));
  const unreviewed = hazards.find((hazard) => !hazard.reviewed);
  if (unreviewed) {
    showToast(`Confirm the control for “${unreviewed.name}” before saving.`);
    return;
  }
  const record = {
    id: uid(), title: template.name, jobId: job.id, owner: safetyFormDraft.signatures[0].name || state.user,
    status: "Current", note: template.description || "Signed safety form.", updated: dateOffset(0), workDate: safetyFormDraft.workDate,
    templateId: template.id, templateFields: template.fields,
    answers: template.fields.map((field) => ({ fieldId: field.id, label: field.label, type: field.type, value: safetyAnswerValue(form, field) })),
    hazards,
    signatures: safetyFormDraft.signatures.slice(), submittedBy: state.user, submittedAt: dateOffset(0),
  };
  state.safety.unshift(record);
  persist();
  safetyFormDraft = null;
  setPage("safety");
  if (printAfter) printSafetyRecord(record.id);
  showToast("Signed safety form saved.");
}

function renderSafetyPrintSheet() {
  const record = state.safety.find((item) => item.id === printingSafetyRecordId);
  if (!record) return "";
  const job = jobById(record.jobId);
  return `<section class="safety-print-sheet">
    <header class="safety-print-head"><div><div class="section-kicker">SIGNED SAFETY FORM</div><h1>${escapeHtml(record.title)}</h1><p>${escapeHtml(job?.name || "Job")} · ${escapeHtml(job?.client || "")} · ${formatDate(record.workDate || record.updated, { month: "long", day: "numeric", year: "numeric" })}</p></div><div>${statusPill(record.status)}</div></header>
    <div class="safety-print-meta"><span><b>Job</b>${escapeHtml(job?.name || "—")}</span><span><b>Location</b>${escapeHtml(job?.location || "—")}</span><span><b>Foreman</b>${escapeHtml(job ? jobForemanName(job) : "—")}</span><span><b>Work date</b>${formatDate(record.workDate || record.updated)}</span></div>
    ${record.note ? `<p class="safety-print-note">${escapeHtml(record.note)}</p>` : ""}
    ${(record.hazards || []).length ? `<h2 class="safety-print-section">Hazards &amp; controls</h2><table class="safety-print-table safety-print-hazards"><thead><tr><th>Hazard</th><th>Control / mitigation</th><th>Reviewed</th></tr></thead><tbody>${record.hazards.map((hazard) => `<tr><td>${escapeHtml(hazard.name)}</td><td>${escapeHtml(hazard.mitigation || "—")}</td><td>${hazard.reviewed ? "Yes" : "No"}</td></tr>`).join("")}</tbody></table>` : ""}
    ${(record.answers || []).length ? `<table class="safety-print-table"><tbody>${record.answers.map((answer) => `<tr><th>${escapeHtml(answer.label)}</th><td>${escapeHtml(String(answer.value ?? "—"))}</td></tr>`).join("")}</tbody></table>` : ""}
    <h2 class="safety-print-section">Crew sign-off</h2>
    ${(record.signatures || []).length ? `<div class="safety-print-signatures">${record.signatures.map((signature) => `<figure><img src="${signature.dataUrl}" alt="Signature of ${escapeHtml(signature.name)}"><figcaption><strong>${escapeHtml(signature.name)}</strong><span>${escapeHtml(signature.role || "Crew member")} · ${escapeHtml(new Date(signature.signedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }))}</span></figcaption></figure>`).join("")}</div>` : `<p>No signatures recorded.</p>`}
    ${record.documentName ? `<p class="safety-print-note">Attached PDF: ${escapeHtml(record.documentName)}</p>` : ""}
    <footer class="safety-print-foot">Generated by Fieldwork · ${formatDate(dateOffset(0), { month: "long", day: "numeric", year: "numeric" })}</footer>
  </section>`;
}

function printSafetyRecord(recordId) {
  if (!state.safety.some((item) => item.id === recordId)) return;
  const previousPage = activePage;
  printingSafetyRecordId = recordId;
  document.body.dataset.printTarget = "safety-record";
  if (activePage !== "safety") setPage("safety");
  else renderPage();
  window.addEventListener("afterprint", () => {
    delete document.body.dataset.printTarget;
    printingSafetyRecordId = "";
    if (previousPage && previousPage !== "safety" && previousPage !== "safety-fill") setPage(previousPage);
    else renderPage();
  }, { once: true });
  window.print();
}

function gapItemAction(item) {
  if (item.kind === "safety") return `<button class="text-link" data-safety-form="${escapeHtml(item.id)}">Review</button>`;
  if (item.kind === "report") return `<button class="text-link" data-daily-report="${escapeHtml(item.id)}">Complete</button>`;
  if (item.kind === "coverage") return `<button class="text-link" data-action="new-safety" data-job-id="${escapeHtml(item.jobId)}">Add sign-off</button>`;
  if (item.kind === "wcb") return `<button class="button button-outline compliance-gap-action" data-action="manage-contractor-wcb" data-company-id="${escapeHtml(item.id)}">WCB letter</button>`;
  if (item.kind === "task") return `<button class="text-link" data-page="tasks">Open tasks</button>`;
  if (item.kind === "job") return `<button class="text-link" data-page="reports">Close out</button>`;
  if (item.kind === "ticket") return `<button class="text-link" data-page="safety-tickets">Open tickets</button>`;
  return "";
}

function renderComplianceGapPanel() {
  const groups = workspaceGapGroups();
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const body = total
    ? groups.map((group) => `<div class="compliance-gap-group"><div class="compliance-gap-head"><strong>${escapeHtml(group.label)}</strong><span>${group.items.length}</span></div><ul class="compliance-gap-list">${group.items.slice(0, 3).map((item) => `<li><div><strong>${escapeHtml(item.primary)}</strong>${item.secondary ? `<span>${escapeHtml(item.secondary)}</span>` : ""}</div>${gapItemAction(item)}</li>`).join("")}</ul>${group.items.length > 3 ? `<p class="compliance-gap-more">+${group.items.length - 3} more</p>` : ""}</div>`).join("")
    : `<div class="empty-state"><strong>Nothing missing</strong>Safety forms, FLHA / tailgate sign-offs, daily reports, crew tasks, WCB clearances, safety tickets, and job close-outs are all up to date.</div>`;
  return `<section class="card panel compliance-gap-panel"><div class="panel-head"><div><h2 class="panel-title">Missing sign-offs &amp; follow-ups</h2><p class="panel-subtitle">${total ? `${total} item${total === 1 ? " needs" : "s need"} attention before field work` : "Nothing needs attention right now"}</p></div><span class="status-pill">${total ? `${total} open` : "Clear"}</span></div>${body}</section>`;
}

function renderSafety() {
  const signedForms = state.safety.filter((form) => (form.signatures || []).length);
  const signatureCount = state.safety.reduce((sum, form) => sum + (form.signatures || []).length, 0);
  const headerActions = `<button class="button button-outline" data-action="safety-template-new"><span>+</span>Create form template</button><button class="button button-primary" data-action="new-safety"><span>+</span>Update safety form</button>`;
  return `${heading("FIELD COMPLIANCE", "Safety & JSA", "Build your own safety forms, fill them out on a phone or tablet, and collect crew signatures before work starts.", headerActions)}
    <div class="metric-grid">
      <article class="card metric-card"><div class="metric-top">Current forms <span class="metric-icon">✓</span></div><div class="metric-value">${state.safety.filter((form) => form.status === "Current").length}</div><div class="metric-note">Reviewed and up to date</div></article>
      <article class="card metric-card"><div class="metric-top">Needs review <span class="metric-icon">!</span></div><div class="metric-value">${state.safety.filter((form) => form.status !== "Current").length}</div><div class="metric-note">Follow up before field work</div></article>
      <article class="card metric-card"><div class="metric-top">Signed forms <span class="metric-icon">◇</span></div><div class="metric-value">${signedForms.length}</div><div class="metric-note">${signatureCount} crew signature${signatureCount === 1 ? "" : "s"} captured</div></article>
      <article class="card metric-card"><div class="metric-top">Forms recorded <span class="metric-icon">▤</span></div><div class="metric-value">${state.safety.length}</div><div class="metric-note">JSA, daily hazard, and custom forms</div></article>
    </div>
    ${renderComplianceGapPanel()}
    ${renderSafetyTemplatesSection()}
    <section class="card panel safety-records-panel"><div class="panel-head"><div><h2 class="panel-title">Safety records</h2><p class="panel-subtitle">Print any signed record to PDF for reporting and job close-out.</p></div></div>
      <div class="safety-grid">${state.safety.map((form) => `<article class="card safety-card"><div class="safety-card-head"><span class="safety-icon">◇</span>${statusPill(form.status)}</div><h3>${escapeHtml(form.title)}</h3><p>${escapeHtml(form.note)}</p>${(form.answers || []).length || (form.hazards || []).length ? `<p class="safety-card-meta">${(form.answers || []).length} item${(form.answers || []).length === 1 ? "" : "s"} answered · ${(form.signatures || []).length} signature${(form.signatures || []).length === 1 ? "" : "s"}${(form.hazards || []).length ? ` · ${form.hazards.length} hazard${form.hazards.length === 1 ? "" : "s"} controlled` : ""}</p>` : ""}<div class="safety-footer"><span>${escapeHtml(shortJobName(form.jobId))} · ${escapeHtml(form.owner)}${form.workDate ? ` · ${formatDate(form.workDate)}` : ` · Updated ${formatDate(form.updated)}`}${form.documentPath || form.documentDataUrl ? " · PDF attached" : ""}</span><div class="safety-footer-actions">${form.documentPath || form.documentDataUrl ? `<button class="text-link" data-safety-document-form="${escapeHtml(form.id)}">View PDF</button>` : ""}<button class="text-link" data-print-safety-record="${escapeHtml(form.id)}">Print / PDF</button><button class="text-link" data-safety-form="${escapeHtml(form.id)}">Review / update</button></div></div></article>`).join("") || `<div class="card empty-state"><strong>No safety forms yet</strong>Create a custom form template or add a JSA / daily hazard review for a job.</div>`}</div>
    </section>
    ${printingSafetyRecordId ? renderSafetyPrintSheet() : ""}`;
}

function renderSafetyLibrary() {
  const folders = state.safetyLibraryFolders || [];
  let currentFolder = folders.find((folder) => folder.id === safetyLibraryFolderId);
  if (safetyLibraryFolderId && !currentFolder) {
    safetyLibraryFolderId = "";
    currentFolder = null;
  }
  const ancestors = [];
  const visited = new Set();
  for (let folder = currentFolder; folder && !visited.has(folder.id); folder = folders.find((item) => item.id === folder.parentId)) {
    visited.add(folder.id);
    ancestors.unshift(folder);
  }
  const childFolders = folders.filter((folder) => folder.parentId === safetyLibraryFolderId);
  const documents = (state.safetyLibrary || [])
    .filter((document) => (document.folderId || "") === safetyLibraryFolderId)
    .sort((first, second) => String(second.uploadedAt || "").localeCompare(String(first.uploadedAt || "")));
  const uploadForm = canManageSafetyLibrary()
    ? `<section class="card panel safety-library-upload"><div class="panel-head"><div><h2 class="panel-title">Add a safety document</h2><p class="panel-subtitle">Upload a PDF to ${currentFolder ? `<strong>${escapeHtml(currentFolder.name)}</strong>` : "the library root"} for everyone in your workspace to view. Maximum file size: 10 MB.</p></div></div>
        <form id="safety-library-upload-form" class="safety-library-form">
          <label>Document title<input class="form-input" name="title" maxlength="120" required placeholder="e.g. Confined space entry procedure"></label>
          <label>Category<select class="form-input" name="category"><option>JSA</option><option>FLHA / tailgate</option><option>Procedures</option><option>Work instructions</option><option>Policies</option><option>Safety data sheets</option><option>Emergency plans</option><option>Training</option><option>Other</option></select></label>
          <label>Assign to job<select class="form-input" name="jobId"><option value="">Not assigned to a job</option>${state.jobs.map((job) => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.name)}</option>`).join("")}</select></label>
          <label class="safety-library-description">Description (optional)<input class="form-input" name="description" maxlength="240" placeholder="Briefly describe when to use this document"></label>
          <label class="safety-library-file">PDF file<input class="form-input" name="file" type="file" accept="application/pdf,.pdf" required></label>
          <button type="submit" class="button button-primary">Add to library</button>
        </form></section>`
    : "";
  const folderCards = childFolders.map((folder) => {
    const documentCount = (state.safetyLibrary || []).filter((document) => document.folderId === folder.id).length;
    const childCount = folders.filter((child) => child.parentId === folder.id).length;
    return `<button type="button" class="card safety-library-folder-card" data-safety-library-folder="${escapeHtml(folder.id)}">
      <span class="safety-library-folder-icon" aria-hidden="true">▰</span>
      <span class="safety-library-folder-copy"><strong>${escapeHtml(folder.name)}</strong><small>${documentCount} PDF${documentCount === 1 ? "" : "s"}${childCount ? ` · ${childCount} subfolder${childCount === 1 ? "" : "s"}` : ""}</small></span>
      <span class="safety-library-folder-arrow" aria-hidden="true">›</span>
    </button>`;
  }).join("");
  const documentCards = documents.map((item) => `<article class="card safety-library-card">
        <div class="safety-library-card-top"><span class="safety-library-icon" aria-hidden="true">PDF</span>${statusPill(item.category || "Other")}</div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.description || item.fileName || "Safety reference document")}</p>
        <div class="safety-library-meta"><span>${formatDate(String(item.uploadedAt || "").slice(0, 10))}${item.uploadedBy ? ` · ${escapeHtml(item.uploadedBy)}` : ""}</span><span>${item.fileSize ? `${(item.fileSize / (1024 * 1024)).toFixed(1)} MB` : "PDF"}</span></div>
        <label class="safety-library-assignment">Assigned job<select class="form-input" data-safety-library-job="${escapeHtml(item.id)}" ${canManageSafetyLibrary() ? "" : "disabled"}><option value="">Not assigned to a job</option>${state.jobs.map((job) => `<option value="${escapeHtml(job.id)}" ${job.id === item.jobId ? "selected" : ""}>${escapeHtml(job.name)}</option>`).join("")}</select></label>
        <div class="safety-library-actions"><button type="button" class="button button-outline" data-safety-library-view="${escapeHtml(item.id)}">View PDF</button>${canManageSafetyLibrary() ? `<button type="button" class="text-link" data-safety-library-delete="${escapeHtml(item.id)}">Remove</button>` : ""}</div>
      </article>`).join("");
  const content = folderCards || documentCards
    ? `<div class="safety-library-grid">${folderCards}${documentCards}</div>`
    : `<div class="card empty-state"><strong>This folder is empty</strong>${canManageSafetyLibrary() ? "Add a safety PDF here or create a subfolder." : "Safety documents added here will appear in this folder."}</div>`;
  const breadcrumbs = `<nav class="safety-library-breadcrumbs" aria-label="Safety library folders">
    <button type="button" class="text-link" data-safety-library-folder="">Safety library</button>
    ${ancestors.map((folder) => `<span aria-hidden="true">/</span><button type="button" class="text-link" data-safety-library-folder="${escapeHtml(folder.id)}" ${folder.id === safetyLibraryFolderId ? 'aria-current="page"' : ""}>${escapeHtml(folder.name)}</button>`).join("")}
  </nav>`;
  const folderAction = canManageSafetyLibrary()
    ? `<button type="button" class="button button-outline" data-action="safety-library-add-folder"><span>+</span>Add subfolder</button>`
    : "";
  return `${heading("FIELD COMPLIANCE", "Safety library", "A shared place for safety policies, procedures, safety data sheets, and other field references.")}
    ${uploadForm}
    <section class="card panel safety-library-browser"><div class="safety-library-browser-head">${breadcrumbs}${folderAction}</div>
      <div class="panel-head"><div><h2 class="panel-title">${escapeHtml(currentFolder?.name || "All safety documents")}</h2><p class="panel-subtitle">${childFolders.length} subfolder${childFolders.length === 1 ? "" : "s"} · ${documents.length} PDF${documents.length === 1 ? "" : "s"}</p></div></div>${content}</section>`;
}

function jobSafetyLibraryDocumentsMarkup(job, documents = (state.safetyLibrary || []).filter((item) => item.jobId === job.id)) {
  if (!documents.length) return "";
  return `<div class="report-safety-docs"><strong>Assigned safety documents</strong><ul class="report-safety-doc-list">${documents.map((item) => `<li class="report-safety-doc-row"><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.category || "Safety reference")}${item.description ? ` · ${escapeHtml(item.description)}` : ""}${item.uploadedBy ? ` · added by ${escapeHtml(item.uploadedBy)}` : ""}</span></div><button class="text-link" data-safety-library-view="${escapeHtml(item.id)}">View PDF</button></li>`).join("")}</ul></div>`;
}

function reportSafetyDocumentsMarkup(job) {
  const documents = state.safety.filter((form) => form.jobId === job.id && (form.documentPath || form.documentDataUrl));
  const records = documents.length
    ? `<div class="report-safety-docs"><strong>Safety form PDFs</strong><ul class="report-safety-doc-list">${documents.map((form) => `<li class="report-safety-doc-row"><div><strong>${escapeHtml(form.documentName || "Safety form PDF")}</strong><span>${escapeHtml(form.title)}${form.workDate ? ` · ${formatDate(form.workDate)}` : ""} · ${escapeHtml(form.owner || "crew")}${form.documentUploadedAt ? ` · uploaded ${formatDate(form.documentUploadedAt)}` : ""}</span></div><button class="text-link report-action" data-safety-document-form="${escapeHtml(form.id)}">View PDF</button></li>`).join("")}</ul></div>`
    : "";
  return `${records}${jobSafetyLibraryDocumentsMarkup(job)}`;
}

function reportSafetyRecordsMarkup(job) {
  const records = state.safety.filter((form) => form.jobId === job.id && ((form.signatures || []).length || (form.answers || []).length));
  if (!records.length) return "";
  return `<div class="report-safety-docs"><strong>Signed safety forms</strong><ul class="report-safety-doc-list">${records.map((form) => `<li class="report-safety-doc-row"><div><strong>${escapeHtml(form.title)}</strong><span>${form.workDate ? formatDate(form.workDate) : `Updated ${formatDate(form.updated)}`} · ${(form.signatures || []).length} signature${(form.signatures || []).length === 1 ? "" : "s"}${(form.hazards || []).length ? ` · ${form.hazards.length} hazard${form.hazards.length === 1 ? "" : "s"}` : ""} · ${escapeHtml(form.owner || "crew")}</span></div><button class="text-link report-action" data-print-safety-record="${escapeHtml(form.id)}">Print / PDF</button></li>`).join("")}</ul></div>`;
}

function printJobReport(jobId) {
  if (!jobById(jobId)) return;
  document.querySelectorAll(".report-job").forEach((section) => section.classList.toggle("print-focus", section.dataset.reportJob === jobId));
  document.body.classList.add("print-job-scope");
  document.body.dataset.printTarget = "reports";
  window.addEventListener("afterprint", () => {
    delete document.body.dataset.printTarget;
    document.body.classList.remove("print-job-scope");
    document.querySelectorAll(".report-job").forEach((section) => section.classList.remove("print-focus"));
  }, { once: true });
  window.print();
}

function renderReports() {
  const submittedCount = state.reports.filter((report) => report.status === "Submitted").length;
  const openCount = state.reports.length - submittedCount;
  const jobsWithSummary = state.jobs.filter((job) => job.finalReport).length;
  const jobSections = state.jobs.map((job) => {
    const jobReports = state.reports.filter((report) => report.jobId === job.id).sort((a, b) => a.date.localeCompare(b.date));
    if (!jobReports.length) {
      return `<section class="card panel report-job" data-report-job="${escapeHtml(job.id)}"><div class="panel-head"><div><h2 class="panel-title">${escapeHtml(job.name)}</h2><p class="panel-subtitle">${formatDate(job.startDate || job.date)}${job.endDate ? ` – ${formatDate(job.endDate)}` : ""} · ${escapeHtml(jobForemanName(job) || "No foreman assigned")}</p></div><div class="report-job-actions">${statusPill(job.status)}<button class="button button-outline report-action" data-action="print-job-report" data-job-id="${escapeHtml(job.id)}">Print / PDF</button></div></div><div class="empty-state"><strong>No daily report workflow</strong>Daily safety forms, work plans, and reports are created automatically for jobs created with a date range.</div>${reportSafetyDocumentsMarkup(job)}${reportSafetyRecordsMarkup(job)}</section>`;
    }
    const allSubmitted = jobReports.every((report) => report.status === "Submitted");
    const endDateReached = (job.endDate || job.date) <= dateOffset(0);
    const finalAction = job.finalReport
      ? `<span class="status-pill">Final summary saved</span>`
      : allSubmitted && endDateReached
        ? `<button class="button button-outline" data-finalize-job="${escapeHtml(job.id)}">Create final summary</button>`
        : `<span class="report-progress">${jobReports.filter((report) => report.status === "Submitted").length}/${jobReports.length} daily reports submitted${allSubmitted && !endDateReached ? ` · Ends ${formatDate(job.endDate)}` : ""}</span>`;
    return `<section class="card panel report-job" data-report-job="${escapeHtml(job.id)}"><div class="panel-head"><div><h2 class="panel-title">${escapeHtml(job.name)}</h2><p class="panel-subtitle">${formatDate(job.startDate || job.date)} – ${formatDate(job.endDate || job.date)} · Foreman: ${escapeHtml(jobForemanName(job) || "Unassigned")}</p></div><div class="report-job-actions">${finalAction}<button class="button button-outline report-action" data-action="print-job-report" data-job-id="${escapeHtml(job.id)}">Print / PDF</button></div></div>
      ${job.finalReport ? `<div class="final-report-summary"><strong>Final job summary · ${formatDate(job.finalReport.submittedAt, { month: "short", day: "numeric", year: "numeric" })}</strong><p>${escapeHtml(job.finalReport.completedWork)}</p>${job.finalReport.outstandingItems ? `<p><b>Outstanding:</b> ${escapeHtml(job.finalReport.outstandingItems)}</p>` : ""}${job.finalReport.finalNotes ? `<p><b>Handoff:</b> ${escapeHtml(job.finalReport.finalNotes)}</p>` : ""}</div>` : ""}
      <div class="report-list">${jobReports.map((report) => `<div class="report-row"><div class="report-date"><strong>${formatDate(report.date, { weekday: "short", month: "short", day: "numeric" })}</strong><span>${escapeHtml(report.status === "Submitted" ? `Submitted by ${report.submittedBy || jobForemanName(job) || "crew"}` : "End-of-day report")}</span></div><div class="report-description">${report.status === "Submitted" ? escapeHtml(report.completedWork) : "Record completed work, any delays or incidents, and the next shift's plan."}</div>${statusPill(report.status)}<button class="text-link" data-daily-report="${escapeHtml(report.id)}">${report.status === "Submitted" ? "View / edit" : "Complete report"}</button></div>`).join("")}</div>
      ${reportSafetyDocumentsMarkup(job)}${reportSafetyRecordsMarkup(job)}
    </section>`;
  }).join("");
  return `${heading("FIELD DOCUMENTATION", "Daily reports", "Complete end-of-day reports for each shift, include signed safety forms and attached PDFs, and close out the job with a final summary.", actionButton("Print all reports", "reports-print", "button-outline", "▤"))}
    <div class="metric-grid">
      <article class="card metric-card"><div class="metric-top">Reports to complete <span class="metric-icon">◷</span></div><div class="metric-value">${openCount}</div><div class="metric-note">Across jobs with daily report workflows</div></article>
      <article class="card metric-card"><div class="metric-top">Reports submitted <span class="metric-icon">✓</span></div><div class="metric-value">${submittedCount}</div><div class="metric-note">Saved to the job record</div></article>
      <article class="card metric-card"><div class="metric-top">Final summaries <span class="metric-icon">▤</span></div><div class="metric-value">${jobsWithSummary}</div><div class="metric-note">Jobs closed out</div></article>
      <article class="card metric-card"><div class="metric-top">Crew leads <span class="metric-icon">♙</span></div><div class="metric-value">${new Set(state.jobs.map((job) => job.crewLead).filter(Boolean)).size}</div><div class="metric-note">Assigned to scheduled jobs</div></article>
    </div>
    ${jobSections || `<section class="card panel"><div class="empty-state"><strong>No jobs yet</strong>Create a job to set up daily reports.</div></section>`}`;
}

function selectOptions(items, selected = "", labelKey = "name") {
  return items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item[labelKey])}</option>`).join("");
}

function jobSelect(name = "jobId", required = true, multiple = false, selected = "") {
  return `<select class="form-input" name="${name}" ${required ? "required" : ""} ${multiple ? "multiple size=\"4\"" : ""}>${multiple ? "" : `<option value="">${required ? "Select a job" : "Unassigned"}</option>`}${selectOptions(state.jobs, selected)}</select>${multiple ? `<div class="form-hint">Hold Ctrl (Windows) or Command (Mac) to select multiple jobs.</div>` : ""}`;
}

function foremanProfileName(profile) {
  return String(profile?.full_name || profile?.email || "").trim();
}

function foremanProfileSelect(name = "foremanUserId", selected = "", required = true) {
  const options = foremanProfilesCache.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === selected ? "selected" : ""}>${escapeHtml(foremanProfileName(profile))}${profile.job_title ? ` · ${escapeHtml(profile.job_title)}` : ""}</option>`).join("");
  const placeholder = required ? "Select an approved foreman" : "Unassigned";
  return `<select class="form-input" name="${name}" ${required ? "required" : ""}><option value="">${foremanProfilesCache.length ? placeholder : "No approved foreman accounts"}</option>${options}</select>${foremanProfilesCache.length ? "" : `<div class="form-hint">An admin must grant the Foreman role in the Admin panel before assigning this job.</div>`}`;
}

const INTERNAL_TEAM_COMPANY_ID = "workspace-internal-team";

function workspaceCrewRoster(companyId = "") {
  const people = new Map();
  const addPerson = (name, role = "Crew member", personCompanyId = INTERNAL_TEAM_COMPANY_ID) => {
    const normalizedName = String(name || "").trim();
    const key = `${personCompanyId}:${normalizedName.toLowerCase()}`;
    if (normalizedName && !people.has(key)) people.set(key, { name: normalizedName, role: role || "Crew member", companyId: personCompanyId });
  };
  state.people.forEach((person) => addPerson(person.name, person.role, person.companyId || INTERNAL_TEAM_COMPANY_ID));
  profilesCache.filter((profile) => ["admin", "manager"].includes(profile.role))
    .forEach((profile) => addPerson(profile.full_name || profile.email, profile.job_title || (profile.role === "admin" ? "Administrator" : "Manager")));
  contractorCrewMembersCache.forEach((member) => addPerson(member.full_name || member.email, "Contractor crew", member.company_id));
  return [...people.values()]
    .filter((person) => !companyId || person.companyId === companyId)
    .sort((first, second) => first.name.localeCompare(second.name));
}

function jobAssignmentCompanies() {
  const companies = new Map();
  [...contractorCompaniesCache, ...contractorCrewMembersCache.map((member) => ({
    id: member.company_id, name: member.company_name, status: "active",
  })), ...state.contractors].forEach((company) => {
    if (!company?.id || !company.name || (company.status && company.status !== "active")) return;
    const key = company.name.trim().toLowerCase();
    const existing = companies.get(key);
    if (!existing || (company.status === "active" && existing.status !== "active")) companies.set(key, company);
  });
  if (workspaceCrewRoster(INTERNAL_TEAM_COMPANY_ID).length) {
    companies.set("workspace-internal-team", { id: INTERNAL_TEAM_COMPANY_ID, name: "Workspace team", status: "active" });
  }
  return [...companies.values()].sort((first, second) => first.name.localeCompare(second.name));
}

function personSelect(name = "assignee", selected = "", { required = true, people = workspaceCrewRoster() } = {}) {
  const emptyHint = people.length ? "" : `<div class="form-hint">No team members are available yet. Add people under People &amp; equipment.</div>`;
  return `<select class="form-input" name="${name}" ${required ? "required" : ""}><option value="">Select a team member</option>${people.map((person) => `<option value="${escapeHtml(person.name)}" ${person.name === selected ? "selected" : ""}>${escapeHtml(person.name)} · ${escapeHtml(person.role)}</option>`).join("")}</select>${emptyHint}`;
}

function renderDailyJobPlan(startDate, endDate, defaultAssignee = "", crewMembers = [], companyId = "", foremanProfile = null) {
  const container = document.getElementById("job-daily-plan");
  if (!container) return;
  const previousPlans = new Map([...container.querySelectorAll(".daily-job-plan-row")].map((row) => {
    const date = row.querySelector(".daily-job-plan-date span").textContent;
    return [date, {
      assignee: row.querySelector('select[name^="dailyAssignee_"]').value,
      tasks: row.querySelector('textarea[name^="dailyTasks_"]').value,
    }];
  }));
  const previousRowsMarkup = [...container.querySelectorAll(".daily-job-plan-row")].map((row) => row.outerHTML).join("");
  container.dataset.defaultAssignee = defaultAssignee;
  container.dataset.selectedCrew = JSON.stringify(crewMembers);
  if (!startDate || !endDate || endDate < startDate) {
    container.innerHTML = `<div class="empty-state">Choose a valid job start and end date to plan each day.</div>${previousRowsMarkup}`;
    return;
  }
  const days = datesBetween(startDate, endDate);
  const rosterByName = new Map();
  const foremanName = foremanProfileName(foremanProfile);
  if (foremanName) {
    rosterByName.set(foremanName.toLowerCase(), {
      name: foremanName,
      role: "Foreman",
      companyId: INTERNAL_TEAM_COMPANY_ID,
    });
  }
  workspaceCrewRoster(companyId)
    .filter((person) => [defaultAssignee, ...crewMembers].includes(person.name))
    .forEach((person) => rosterByName.set(person.name.toLowerCase(), person));
  const roster = [...rosterByName.values()];
  const assigneeOptions = (selectedName) => `<option value="">Select a team member</option>${roster.map((person) => `<option value="${escapeHtml(person.name)}" ${person.name === selectedName ? "selected" : ""}>${escapeHtml(person.name)} · ${escapeHtml(person.role)}</option>`).join("")}`;
  container.innerHTML = days.map((date) => `<article class="daily-job-plan-row">
    <div class="daily-job-plan-date"><strong>${formatDate(date, { weekday: "long", month: "short", day: "numeric", year: "numeric" })}</strong><span>${date}</span></div>
    <label class="daily-job-plan-assignee">Assign to<select class="form-input" name="dailyAssignee_${date}" required>${assigneeOptions(roster.some((person) => person.name === previousPlans.get(date)?.assignee) ? previousPlans.get(date).assignee : defaultAssignee)}</select></label>
    <label class="daily-job-plan-tasks">Planned tasks<textarea class="form-textarea" name="dailyTasks_${date}" rows="2" placeholder="Add one task per line for this day" required>${escapeHtml(previousPlans.get(date)?.tasks || "")}</textarea></label>
  </article>`).join("");
}

function refreshJobCrewSelectors(form, reset = false) {
  const companyId = form.elements.companyId.value;
  const foremanSelect = form.elements.foremanUserId;
  const crewSelect = form.elements.crewMembers;
  const previousForeman = reset ? "" : foremanSelect.value;
  const previousCrew = reset ? [] : [...crewSelect.selectedOptions].map((option) => option.value);
  foremanSelect.innerHTML = `<option value="">Select an approved foreman</option>${foremanProfilesCache.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === previousForeman ? "selected" : ""}>${escapeHtml(foremanProfileName(profile))}${profile.job_title ? ` · ${escapeHtml(profile.job_title)}` : ""}</option>`).join("")}`;
  const foremanProfile = foremanProfilesCache.find((profile) => profile.id === foremanSelect.value);
  const roster = workspaceCrewRoster(companyId)
    .filter((person) => person.name.toLowerCase() !== foremanProfileName(foremanProfile).toLowerCase());
  foremanSelect.disabled = !foremanProfilesCache.length;
  crewSelect.innerHTML = roster.map((person) => `<option value="${escapeHtml(person.name)}" ${previousCrew.includes(person.name) ? "selected" : ""}>${escapeHtml(person.name)} · ${escapeHtml(person.role)}</option>`).join("");
  crewSelect.disabled = !companyId || !roster.length;
  const hint = crewSelect.parentElement.querySelector(".form-hint");
  if (hint) hint.textContent = roster.length
    ? "Select up to 10 additional members from the selected company. Hold Ctrl (Windows) or Command (Mac) to select multiple."
    : "No members are available for this company. Add or approve members in the admin panel.";
  const selectedCrew = [...crewSelect.selectedOptions].map((option) => option.value);
  const container = document.getElementById("job-daily-plan");
  if (container) container.dataset.selectedCrew = JSON.stringify(selectedCrew);
  renderDailyJobPlan(form.elements.startDate.value, form.elements.endDate.value, foremanProfileName(foremanProfile), selectedCrew, companyId, foremanProfile);
}

async function loadContractorCrewMembers() {
  if (!supabaseClient || !["admin", "manager"].includes(userProfile?.role)) return false;
  const { data, error } = await supabaseClient.rpc("workspace_contractor_crew_members");
  if (error) {
    console.error("Could not load approved contractor crew users.", error);
    showToast("Could not load company users. Apply the latest contractor workflow SQL migration.");
    return false;
  }
  contractorCrewMembersCache = data || [];
  const knownCompanies = new Map(contractorCompaniesCache.map((company) => [company.id, company]));
  contractorCrewMembersCache.forEach((member) => {
    if (!knownCompanies.has(member.company_id)) {
      knownCompanies.set(member.company_id, { id: member.company_id, name: member.company_name, status: "active" });
    }
  });
  contractorCompaniesCache = [...knownCompanies.values()];
  return true;
}

function contractorCrewProfiles(companyId = "") {
  if (!companyId) return [];
  return contractorCrewMembersCache.filter((profile) => profile.company_id === companyId);
}

function crewUserOptions(companyId = "") {
  const users = contractorCrewProfiles(companyId);
  return `<option value="">${companyId ? users.length ? "Select an approved company user" : "No approved users for this company" : "Select a company first"}</option>${users.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.full_name || profile.email)}${profile.full_name && profile.email ? ` · ${escapeHtml(profile.email)}` : ""}</option>`).join("")}`;
}

function field(label, name, input, full = false) {
  return `<div class="form-field ${full ? "full" : ""}"><label for="field-${name}">${label}</label><div id="field-${name}">${input}</div></div>`;
}

function openForm(kind, recordId = "") {
  if (kind === "safety-template") {
    pdfFormFieldSuggestions = [];
    jsaAnalysisState = null;
  }
  const forms = {
    "configure-contractor-workflow": (() => {
      const company = contractorCompaniesCache.find((item) => item.id === recordId);
      if (!company) return null;
      const rates = adminContractorRates.find((item) => item.company_id === company.id) || {};
      const assignedJobIds = new Set(adminContractorAssignments.filter((item) => item.company_id === company.id).map((item) => item.job_id));
      const currentAssetIds = new Set(adminContractorJobEquipment.filter((item) => item.company_id === company.id).map((item) => item.equipment_id));
      const assets = adminContractorEquipment.filter((item) => item.company_id === company.id && item.active);
      return {
        title: `Rates & job assignments · ${company.name}`,
        intro: "All six rates are required. Choose jobs and the owned equipment available on those jobs.",
        fields: [
          field("Hours · hourly price", "hourly_rate", `<input class="form-input" type="number" min="0.01" step="0.01" name="hourly_rate" value="${escapeHtml(rates.hourly_rate || "")}" required>`),
          field("Subsistence · daily price", "subsistence_daily_rate", `<input class="form-input" type="number" min="0.01" step="0.01" name="subsistence_daily_rate" value="${escapeHtml(rates.subsistence_daily_rate || "")}" required>`),
          field("Truck · daily price", "truck_daily_rate", `<input class="form-input" type="number" min="0.01" step="0.01" name="truck_daily_rate" value="${escapeHtml(rates.truck_daily_rate || "")}" required>`),
          field("UTV · daily price", "utv_daily_rate", `<input class="form-input" type="number" min="0.01" step="0.01" name="utv_daily_rate" value="${escapeHtml(rates.utv_daily_rate || "")}" required>`),
          field("ATV · daily price", "atv_daily_rate", `<input class="form-input" type="number" min="0.01" step="0.01" name="atv_daily_rate" value="${escapeHtml(rates.atv_daily_rate || "")}" required>`),
          field("Snowmobile · daily price", "snowmobile_daily_rate", `<input class="form-input" type="number" min="0.01" step="0.01" name="snowmobile_daily_rate" value="${escapeHtml(rates.snowmobile_daily_rate || "")}" required>`),
          field("Assigned jobs", "job_ids", `<select class="form-input" name="job_ids" multiple size="5">${state.jobs.map((job) => `<option value="${escapeHtml(job.id)}" ${assignedJobIds.has(job.id) ? "selected" : ""}>${escapeHtml(job.name)}</option>`).join("")}</select><span class="form-hint">Use Ctrl / Cmd to select more than one job. Leave empty to configure rates before assigning work.</span>`, true),
          field("Equipment enabled for those jobs", "equipment_ids", assets.length ? `<select class="form-input" name="equipment_ids" multiple size="5">${assets.map((asset) => `<option value="${escapeHtml(asset.id)}" ${currentAssetIds.has(asset.id) ? "selected" : ""}>${escapeHtml(asset.name)} · ${escapeHtml(asset.equipment_type)} · ${escapeHtml(asset.serial_number)}</option>`).join("")}</select><span class="form-hint">Selected assets will be enabled on every selected job.</span>` : `<span class="form-hint">Add owned equipment before enabling it on jobs.</span>`, true),
        ], submit: "Save rates & assignments",
      };
    })(),
    "manage-contractor-wcb": (() => {
      const company = userProfile?.role === "contractor"
        ? contractorCompany
        : contractorCompaniesCache.find((item) => item.id === recordId);
      if (!company || company.id !== recordId) return null;
      return {
        title: `WCB clearance · ${company.name}`,
        intro: "Upload the company's WCB clearance letter and enter the date it expires. The status shows Valid only while the letter is on file and unexpired.",
        fields: [
          field("Letter expiry date", "wcb_expires_on", `<input class="form-input" type="date" name="wcb_expires_on" value="${escapeHtml(company.wcb_expires_on || "")}" required>`),
          field(company.wcb_letter_path ? "Replace clearance letter (optional)" : "WCB clearance letter", "wcb_letter", `<input class="form-input" type="file" name="wcb_letter" accept="application/pdf,image/jpeg,image/png,image/webp" ${company.wcb_letter_path ? "" : "required"}><span class="form-hint">PDF, JPG, PNG, or WebP · maximum 10 MB${company.wcb_letter_path ? " · leave empty to keep the current letter" : ""}</span>`, true),
        ],
        submit: company.wcb_letter_path ? "Save WCB clearance" : "Upload WCB letter",
      };
    })(),
    "add-contractor-equipment": (() => {
      const company = contractorCompaniesCache.find((item) => item.id === recordId);
      if (!company) return null;
      return {
        title: `Add company equipment · ${company.name}`,
        intro: "Register an asset owned by this contractor. Admins can enable it on selected jobs.",
        fields: [
          field("Equipment type", "equipment_type", `<select class="form-input" name="equipment_type" required><option value="truck">Truck</option><option value="utv">UTV</option><option value="atv">ATV</option><option value="snowmobile">Snowmobile</option></select>`),
          field("Asset name", "name", `<input class="form-input" name="name" required placeholder="e.g. Crew truck 01">`),
          field("Serial / identifier", "serial_number", `<input class="form-input" name="serial_number" required placeholder="VIN or asset ID">`),
        ], submit: "Register equipment",
      };
    })(),
    "new-contractor-invoice": (() => {
      const job = contractorWorkflow.jobs.find((item) => item.job_id === recordId) || contractorWorkflow.jobs[0];
      return {
        title: "Create contractor invoice",
        intro: "Your company rates are applied by the database. A 5% Alberta GST is applied to your invoice subtotal.",
        fields: [
          field("Assigned job", "job_id", `<select id="contractor-invoice-job" class="form-input" name="job_id" required>${contractorWorkflow.jobs.map((item) => `<option value="${escapeHtml(item.job_id)}" ${item.job_id === job?.job_id ? "selected" : ""}>${escapeHtml(item.job_name)}</option>`).join("")}</select>`),
          field("Invoice number", "invoice_number", `<input class="form-input" name="invoice_number" required>`),
          field("Work date", "work_date", `<input class="form-input" type="date" name="work_date" value="${dateOffset(0)}" required>`),
          field("Hours", "labor_hours", `<input class="form-input" type="number" min="0" step="0.25" name="labor_hours" value="0">`),
          field("Subsistence days", "subsistence_days", `<input class="form-input" type="number" min="0" step="0.5" name="subsistence_days" value="0">`),
          field("Assigned equipment · rental days", "equipment_usage", `<div id="contractor-invoice-equipment">${contractorInvoiceEquipmentFields(job?.job_id || "")}</div>`, true),
          field("Notes", "notes", `<textarea class="form-textarea" name="notes" placeholder="Optional supporting details"></textarea>`, true),
        ], submit: "Submit invoice",
      };
    })(),
    "new-employee-invite": {
      title: "Invite a company employee",
      intro: "The invited email will be tied to your company. Fieldwork still reviews and approves each employee account.",
      fields: [field("Employee email", "email", `<input class="form-input" type="email" name="email" required placeholder="employee@company.com">`, true)],
      submit: "Create invitation link",
    },
    "new-task": {
      title: "Assign a daily task", intro: "Give your crew a clear next step.",
      fields: [
        field("Task name", "title", `<input class="form-input" name="title" placeholder="e.g. Inspect launcher seals" required>`),
        field("Assign to", "assignee", personSelect()),
        field("Jobs", "jobIds", jobSelect("jobIds", true, true), true),
        field("Due date", "due", `<input class="form-input" type="date" name="due" value="${dateOffset(0)}" required>`),
        field("Priority", "priority", `<select class="form-input" name="priority"><option>Normal</option><option>High</option></select>`),
      ], submit: "Assign task",
    },
    "assign-foreman": (() => {
      const job = jobById(recordId);
      if (!job) return null;
      return {
        title: `Assign foreman · ${job.name}`,
        intro: "The selected foreman will be able to sign in and view only this job and its associated safety records.",
        fields: [field("Foreman account", "foremanUserId", foremanProfileSelect("foremanUserId", job.foremanUserId || "", false))],
        submit: "Save foreman assignment",
      };
    })(),
    "new-job": {
      title: "Create a job", intro: "Assign a foreman account, set project dates, and plan daily work alongside safety checks and reports.",
      fields: [
        field("Job name", "name", `<input class="form-input" name="name" placeholder="e.g. East Line — Section 2" required>`),
        field("Client", "client", `<select class="form-input" name="client" required><option value="">Select a client</option>${state.clients.map((client) => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)}</option>`).join("")}</select>${state.clients.length ? "" : `<div class="form-hint">Add a client in the Admin panel before creating a job.</div>`}`),
        field("Location", "location", `<input class="form-input" name="location" placeholder="City, state" required>`),
        field("Start date", "startDate", `<input class="form-input" type="date" name="startDate" value="${dateOffset(1)}" required>`),
        field("End date", "endDate", `<input class="form-input" type="date" name="endDate" value="${dateOffset(2)}" required>`),
        field("Company", "companyId", `<select id="job-crew-company" class="form-input" name="companyId" required><option value="">Select a company</option>${jobAssignmentCompanies().map((company) => `<option value="${escapeHtml(company.id)}">${escapeHtml(company.name)}</option>`).join("")}</select><div class="form-hint">Companies are managed by workspace admins.</div>`, true),
        field("Project latitude (optional)", "siteLatitude", `<input class="form-input" type="number" step="any" min="-80" max="84" name="siteLatitude" placeholder="e.g. 53.5461">`),
        field("Project longitude (optional)", "siteLongitude", `<input class="form-input" type="number" step="any" min="-180" max="180" name="siteLongitude" placeholder="e.g. -113.4938"><div class="form-hint">Enter both coordinates to center the GPS workspace on the project site.</div>`),
        field("Foreman account", "foremanUserId", foremanProfileSelect()),
        field("Crew members (up to 10)", "crewMembers", `<select id="job-crew-members" class="form-input crew-members-select" name="crewMembers" multiple size="5" disabled></select><div class="form-hint">Select up to 10 additional members from the selected company. Hold Ctrl (Windows) or Command (Mac) to select multiple.</div>`, true),
        field("Project objectives", "scopeObjectives", `<textarea class="form-textarea" name="scopeObjectives" placeholder="What should this project achieve?"></textarea>`, true),
        field("Included work", "scopeIncludedWork", `<textarea class="form-textarea" name="scopeIncludedWork" placeholder="Describe the work and services included"></textarea>`, true),
        field("Deliverables", "scopeDeliverables", `<textarea class="form-textarea" name="scopeDeliverables" placeholder="Reports, records, or other required outputs"></textarea>`),
        field("Exclusions", "scopeExclusions", `<textarea class="form-textarea" name="scopeExclusions" placeholder="Work or services outside this scope"></textarea>`),
        field("Acceptance criteria", "scopeAcceptanceCriteria", `<textarea class="form-textarea" name="scopeAcceptanceCriteria" placeholder="How completion and acceptance will be confirmed"></textarea>`, true),
        field("Daily work plan", "dailyPlan", `<div class="form-hint">Add the tasks and assigned team member for each work day. Use one task per line.</div><div id="job-daily-plan" class="daily-job-plan-list"></div>`, true),
        field("Status", "status", `<select class="form-input" name="status"><option>Scheduled</option><option>In progress</option></select>`),
        field("GPS workspace", "openGpsWorkspace", `<label class="gps-open-after-create"><input type="checkbox" name="openGpsWorkspace" value="yes"><span>Open the GPS workspace after creating this project</span></label>`, true),
      ], submit: "Create project workflow",
    },
    "new-run": {
      title: "Log a tool run", intro: "Record the run type, tool, crew, and job.",
      fields: [
        field("Run type", "type", `<select class="form-input" name="type"><option>ILI</option><option>Cleaning</option><option>Gauging</option><option>Other</option></select>`),
        field("Run date", "date", `<input class="form-input" type="date" name="date" value="${dateOffset(0)}" required>`),
        field("Job", "jobId", jobSelect()),
        field("Operator", "operator", personSelect("operator")),
        field("Tool / equipment", "tool", `<select class="form-input" name="tool"><option value="">Select equipment</option>${state.equipment.map((item) => `<option>${escapeHtml(item.name)}</option>`).join("")}<option>Other / not listed</option></select>`),
        field("Status", "status", `<select class="form-input" name="status"><option>Planned</option><option>In progress</option><option>Complete</option></select>`),
        field("Run notes", "notes", `<textarea class="form-textarea" name="notes" placeholder="Direction, pass number, or field notes"></textarea>`, true),
      ], submit: "Save run",
    },
    "new-person": {
      title: "Add crew", intro: "Add a crew member to an admin-managed company, or link an approved contractor user.",
      fields: [
        field("Company", "companyId", `<select id="crew-company" class="form-input" name="companyId" required><option value="">Select a company</option>${jobAssignmentCompanies().map((company) => `<option value="${escapeHtml(company.id)}">${escapeHtml(company.name)}</option>`).join("")}</select>`),
        field("Crew member name", "name", `<input class="form-input" name="name" placeholder="Enter name if not selecting an approved user">`),
        field("Approved company user", "userId", `<select id="crew-user" class="form-input" name="userId" disabled>${crewUserOptions()}</select><span class="form-hint">Link an approved company account when available; otherwise add a crew name above.</span>`),
        field("Crew role", "role", `<select class="form-input" name="role" required><option value="">Select a crew role</option>${CREW_ROLE_OPTIONS.map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(role)}</option>`).join("")}</select>`),
        field("Assigned jobs", "jobIds", jobSelect("jobIds", false, true), true),
      ], submit: "Add person",
    },
    "new-equipment": {
      title: "Add equipment", intro: "Register the equipment your operation uses. Enter any name and category; this list is separate from tool-run types.",
      fields: [
        field("Equipment name", "name", `<input class="form-input" name="name" placeholder="e.g. Pickup truck 12, compressor, or excavator" required>`),
        field("Category", "type", `<input class="form-input" name="type" list="equipment-category-options" placeholder="Enter any equipment category" required><datalist id="equipment-category-options">${[...new Set(state.equipment.map((item) => item.type).filter((type) => type && !["ili tool", "cleaning tool", "cleaner", "cleaners", "gauging tool", "tracking", "other"].includes(type.trim().toLowerCase())))].sort().map((type) => `<option value="${escapeHtml(type)}"></option>`).join("")}</datalist><div class="form-hint">Enter your own category, or select a category already in use.</div>`),
        field("Serial number", "serial", `<input class="form-input" name="serial" placeholder="Asset serial or ID" required>`),
        field("Assign to job", "jobId", jobSelect("jobId", false)),
        field(`Equipment already registered (${state.equipment.length})`, "equipmentInventory", state.equipment.length
          ? `<ul class="equipment-modal-list">${state.equipment.map((item) => `<li><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.type || "Uncategorized")} · ${escapeHtml(item.serial || "No serial")} · ${escapeHtml(item.jobId ? shortJobName(item.jobId) : "Unassigned")}</span></div><button type="button" class="button button-outline equipment-remove-button" data-action="delete-equipment" data-equipment-id="${escapeHtml(item.id)}">Delete</button></li>`).join("")}</ul>`
          : `<div class="empty-state equipment-modal-empty">No equipment has been added yet.</div>`, true),
      ], submit: "Add equipment",
    },
    "new-invoice": {
      title: "Add contractor invoice", intro: "Choose a registered company and link its invoice to a job.",
      fields: [
        field("Contractor company", "contractorId", `<select class="form-input" name="contractorId" required><option value="">Select a company</option>${selectOptions(state.contractors, "", "name")}</select>${state.contractors.length ? "" : `<div class="form-hint">Add a contractor company first.</div>`}`),
        field("Invoice number", "number", `<input class="form-input" name="number" placeholder="Invoice reference" required>`),
        field("Job", "jobId", jobSelect()),
        field("Amount (CAD, before GST)", "amount", `<input class="form-input" type="number" min="0.01" step="0.01" name="amount" placeholder="0.00" required>`),
        field("Due date", "due", `<input class="form-input" type="date" name="due" value="${dateOffset(14)}" required>`),
      ], submit: "Save invoice",
    },
    "new-contractor": {
      title: "Add contractor company", intro: "Register a company so its invoices can be assigned consistently.",
      fields: [
        field("Company name", "name", `<input class="form-input" name="name" placeholder="Contractor or supplier name" required>`, true),
      ], submit: "Add company",
    },
    "new-client": {
      title: "Add client", intro: "Register the official client name. Jobs will use this list to keep client records consistent.",
      fields: [
        field("Client name", "name", `<input class="form-input" name="name" placeholder="Client or operator name" required>`, true),
      ], submit: "Add client",
    },
    "edit-pricing": (() => {
      const company = contractorById(recordId);
      if (!company) return null;
      const roles = contractorRoles();
      const equipmentTypes = contractorEquipmentTypes();
      return {
        title: `Pricing · ${company.name}`,
        intro: "Set this company's billable hourly labor and per-day equipment rates. Leave a rate blank if it is not offered.",
        fields: [
          ...roles.map((role, index) => field(`${role} · hourly rate (CAD/hr)`, `laborRate_${index}`, pricingRateInput(`laborRate_${index}`, company.pricing.laborRates[role]))),
          ...equipmentTypes.map((type, index) => field(`${type} · daily rental (CAD/unit/day)`, `equipmentRate_${index}`, pricingRateInput(`equipmentRate_${index}`, company.pricing.equipmentRates[type]))),
        ], submit: "Save pricing template",
      };
    })(),
    "new-contractor-submission": {
      title: "Submit contractor hours & equipment",
      intro: "Demo contractor submission · charges use the selected company's saved rates.",
      fields: [
        field("Contractor company", "contractorId", `<select class="form-input" name="contractorId" required><option value="">Select a company</option>${selectOptions(state.contractors, "", "name")}</select>`, true),
        field("Job", "jobId", jobSelect()),
        field("Work date", "date", `<input class="form-input" type="date" name="date" value="${dateOffset(0)}" required>`),
        field("Labor role", "role", `<select class="form-input" name="role"><option value="">No labor hours</option>${contractorRoles().map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(role)}</option>`).join("")}</select>`),
        field("Hours", "hours", `<input class="form-input" type="number" min="0" step="0.25" name="hours" value="0" required>`),
        field("Equipment type", "equipmentType", `<select class="form-input" name="equipmentType"><option value="">No equipment</option>${contractorEquipmentTypes().map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}</select>`),
        field("Equipment quantity", "equipmentQuantity", `<input class="form-input" type="number" min="0" step="1" name="equipmentQuantity" value="0" required>`),
        field("Rental days", "equipmentDays", `<input class="form-input" type="number" min="0" step="1" name="equipmentDays" value="0" required>`),
        field("Notes", "notes", `<textarea class="form-textarea" name="notes" placeholder="Shift details, equipment identifiers, or supporting notes"></textarea>`, true),
        `<div class="form-field full"><div id="contractor-pricing-preview" class="pricing-preview">Select a company to see its configured rates.</div></div>`,
        `<div class="form-field full"><p class="form-hint">Enter labor hours or equipment quantity and rental days, or submit both. The admin will review charges before invoicing.</p></div>`,
      ], submit: "Submit for admin review",
    },
    "new-safety": {
      title: "Update a safety form", intro: "Record a JSA or daily hazard / loss analysis review.",
      fields: [
        field("Form type", "title", `<select class="form-input" name="title"><option>Job Safety Analysis (JSA)</option><option>Daily Hazard / Loss Analysis (DHLA)</option><option>Field Level Hazard Assessment (FLHA)</option><option>Tailgate Safety Meeting</option></select>`),
        field("Job", "jobId", jobSelect("jobId", true, false, recordId)),
        field("Work date", "workDate", `<input class="form-input" type="date" name="workDate" value="${dateOffset(0)}" required>`),
        field("Owner", "owner", personSelect("owner")),
        field("Review status", "status", `<select class="form-input" name="status"><option>Current</option><option>Needs review</option></select>`),
        field("Safety form PDF (optional)", "document", `<input class="form-input" type="file" name="document" accept="application/pdf"><div class="form-hint">Attach the signed JSA, DHLA, FLHA, or tailgate form. PDF only, maximum 10 MB.</div>`, true),
        field("Review notes", "note", `<textarea class="form-textarea" name="note" placeholder="Hazards reviewed, controls, or follow-up actions"></textarea>`, true),
      ], submit: "Save safety update",
    },
    "new-safety-ticket": {
      title: "Add safety ticket", intro: "Add one qualification, its expiry date, and a photo of the ticket. Photos are private to authorized accounts.",
      fields: [
        field("Ticket / qualification", "ticket-title", `<input class="form-input" name="title" placeholder="e.g. H2S Alive, First Aid, Confined Space" required>`),
        field("Issuing organization", "ticket-issuer", `<input class="form-input" name="issuer" placeholder="Training provider or authority" required>`),
        field("Ticket number", "ticket-number", `<input class="form-input" name="ticket_number" placeholder="Certificate or card number">`),
        field("Issue date", "ticket-issued", `<input class="form-input" type="date" name="issued_on" required>`),
        field("Expiry date", "ticket-expires", `<input class="form-input" type="date" name="expires_on" required>`),
        field("Ticket photo", "ticket-photo", `<input class="form-input" type="file" name="photo" accept="image/jpeg,image/png,image/webp" required><span class="form-hint">JPG, PNG, or WebP · maximum 10 MB</span>`, true),
      ], submit: "Save safety ticket",
    },
    "safety-template": (() => {
      const template = (state.safetyTemplates || []).find((item) => item.id === recordId);
      const existingFields = template?.fields?.length ? template.fields : [{ id: uid(), label: "", type: "yesno", required: true }];
      return {
        title: template ? `Edit safety form · ${template.name}` : "Create a safety form",
        intro: "Add your own questions and checks. Crew can then fill the form on a phone or tablet and sign off with a signature.",
        fields: [
          field("Form name", "name", `<input class="form-input" name="name" value="${escapeHtml(template?.name || "")}" placeholder="e.g. Daily FLHA, Tailgate Meeting, Equipment Pre-check" required>`),
          field("Description", "description", `<textarea class="form-textarea" name="description" placeholder="What this form is for">${escapeHtml(template?.description || "")}</textarea>`, true),
          field("Job (optional)", "jobId", jobSelect("jobId", false, false, template?.jobId || "")),
          field("Start from a PDF", "pdfImport", `<div class="jsa-analyze"><div class="jsa-analyze-row"><input class="form-input" type="file" id="pdf-form-file" accept="application/pdf"><button type="button" class="button button-outline" data-action="import-pdf-form">Import PDF fields</button></div><div class="form-hint">Extracts selectable text from the PDF and suggests editable form items. Scanned or image-only PDFs are not supported. Review suggestions before adding them.</div><div id="pdf-form-import-results" class="jsa-analysis-results"></div></div>`, true),
          field("Form items", "formItems", `<div id="template-field-list" class="template-field-list">${existingFields.map((item) => renderTemplateFieldRow(item)).join("")}</div><button type="button" class="button button-outline" data-action="add-template-field"><span>+</span>Add item</button><div class="form-hint">Items can be Yes/No checks, confirmations, text, numbers, or dates. Required items must be completed before the form can be signed and saved.</div>`, true),
          field("Hazards & controls", "hazards", `<div id="template-hazard-list" class="template-hazard-list">${(template?.hazards || []).map((hazard) => renderTemplateHazardRow(hazard)).join("")}</div><div class="template-hazard-add"><select class="form-input" id="hazard-library-select"><option value="">Select a hazard from the library</option>${HAZARD_LIBRARY.map((hazard) => `<option value="${escapeHtml(hazard.id)}">${escapeHtml(hazard.category)} · ${escapeHtml(hazard.name)}</option>`).join("")}</select><button type="button" class="button button-outline" data-action="add-library-hazard">Add hazard</button><button type="button" class="text-link" data-action="repeat-recent-hazards">Repeat recent hazards</button></div><div class="template-hazard-custom"><input class="form-input" id="hazard-custom-name" placeholder="Custom hazard"><input class="form-input" id="hazard-custom-mitigation" placeholder="Control / mitigation"><button type="button" class="button button-outline" data-action="add-custom-hazard">Add custom</button></div><div class="form-hint">Includes repetitive-strain, manual handling, weather, wildlife, and other common field hazards. Crew confirm each control on the signed form.</div>`, true),
          field("Analyze a JSA", "jsaAnalysis", `<div class="jsa-analyze"><div class="jsa-analyze-row"><input class="form-input" type="file" id="jsa-file" accept="application/pdf"><button type="button" class="button button-outline" data-action="analyze-jsa">Analyze JSA</button></div><textarea class="form-textarea" id="jsa-text" rows="3" placeholder="Or paste JSA text here — scope, hazards, controls, permits, PPE, emergency response"></textarea><div class="form-hint">Upload a JSA PDF or paste its text. The analysis suggests form sections and hazard mitigations to add to this template.</div><div id="jsa-analysis-results" class="jsa-analysis-results"></div></div>`, true),
        ],
        submit: template ? "Save form template" : "Create form template",
      };
    })(),
    "start-safety-form": (() => {
      const template = (state.safetyTemplates || []).find((item) => item.id === recordId);
      if (!template) return null;
      return {
        title: `Start ${template.name}`,
        intro: "Choose the job and work date for this safety form.",
        fields: [
          field("Job", "jobId", jobSelect("jobId", true, false, template.jobId || "")),
          field("Work date", "date", `<input class="form-input" type="date" name="date" value="${dateOffset(0)}" required>`),
        ],
        submit: "Start form",
      };
    })(),
    "crew-time": (() => {
      const job = jobById(recordId);
      if (!job) return null;
      const crew = foremanJobCrew(job);
      return {
        title: `Add crew time · ${job.name}`,
        intro: "Record regular and overtime hours for a crew member on this job.",
        fields: [
          field("Crew member", "personName", `<select class="form-input" name="personName" required><option value="">Select a crew member</option>${crew.map((person) => `<option value="${escapeHtml(person.name)}">${escapeHtml(person.name)} · ${escapeHtml(person.role)}</option>`).join("")}</select>${crew.length ? "" : `<div class="form-hint">No crew members are assigned to this job yet.</div>`}`),
          field("Work date", "date", `<input class="form-input" type="date" name="date" value="${dateOffset(0)}" required>`),
          field("Regular hours", "hours", `<input class="form-input" type="number" min="0" max="24" step="0.25" name="hours" value="8" required>`),
          field("Overtime hours", "overtimeHours", `<input class="form-input" type="number" min="0" max="24" step="0.25" name="overtimeHours" value="0" required>`),
          field("Notes", "notes", `<textarea class="form-textarea" name="notes" placeholder="Shift notes, tasks completed, or adjustments"></textarea>`, true),
        ], submit: "Save crew time",
      };
    })(),
    "contractor-time": (() => {
      const job = jobById(recordId);
      if (!job) return null;
      const contractors = foremanJobContractors(job);
      if (!contractors.length) return null;
      return {
        title: `Add contractor time · ${job.name}`,
        intro: "Record hours for a contractor crew member assigned to this project.",
        fields: [
          field("Contractor", "personKey", `<select class="form-input" name="personKey" required><option value="">Select a contractor</option>${contractors.map((person) => `<option value="${escapeHtml(`${person.companyId}||${person.name}`)}">${escapeHtml(person.name)} · ${escapeHtml(person.companyName)}</option>`).join("")}</select>`),
          field("Work date", "date", `<input class="form-input" type="date" name="date" value="${dateOffset(0)}" required>`),
          field("Regular hours", "hours", `<input class="form-input" type="number" min="0" max="24" step="0.25" name="hours" value="8" required>`),
          field("Overtime hours", "overtimeHours", `<input class="form-input" type="number" min="0" max="24" step="0.25" name="overtimeHours" value="0" required>`),
          field("Notes", "notes", `<textarea class="form-textarea" name="notes" placeholder="Shift notes, tasks completed, or adjustments"></textarea>`, true),
        ], submit: "Save contractor time",
      };
    })(),
    "foreman-task": (() => {
      const job = jobById(recordId);
      if (!job) return null;
      const crew = foremanJobCrew(job);
      return {
        title: `Assign task · ${job.name}`,
        intro: "Add a task for this job and assign it to a crew member.",
        fields: [
          field("Task", "title", `<input class="form-input" name="title" placeholder="e.g. Verify launcher seals" required>`),
          field("Assign to", "assignee", `<select class="form-input" name="assignee" required><option value="">Select a crew member</option>${crew.map((person) => `<option value="${escapeHtml(person.name)}">${escapeHtml(person.name)} · ${escapeHtml(person.role)}</option>`).join("")}</select>`),
          field("Due date", "due", `<input class="form-input" type="date" name="due" value="${dateOffset(0)}" required>`),
          field("Priority", "priority", `<select class="form-input" name="priority"><option>Normal</option><option>High</option></select>`),
        ], submit: "Assign task",
      };
    })(),
    "edit-timesheet": (() => {
      const entry = (state.timesheets || []).find((item) => item.id === recordId);
      if (!entry) return null;
      return {
        title: `Edit time · ${entry.personName}`,
        intro: `${shortJobName(entry.jobId)} · ${entry.kind === "contractor" ? "Contractor" : "Crew"} time`,
        fields: [
          field("Work date", "date", `<input class="form-input" type="date" name="date" value="${escapeHtml(entry.date || "")}" required>`),
          field("Regular hours", "hours", `<input class="form-input" type="number" min="0" max="24" step="0.25" name="hours" value="${Number(entry.hours || 0)}" required>`),
          field("Overtime hours", "overtimeHours", `<input class="form-input" type="number" min="0" max="24" step="0.25" name="overtimeHours" value="${Number(entry.overtimeHours || 0)}" required>`),
          field("Notes", "notes", `<textarea class="form-textarea" name="notes" placeholder="Shift notes, tasks completed, or adjustments">${escapeHtml(entry.notes || "")}</textarea>`, true),
        ], submit: "Save time",
      };
    })(),
  };
  if (kind === "daily-report") {
    const report = state.reports.find((item) => item.id === recordId);
    if (!report) return;
    const job = jobById(report.jobId);
    forms[kind] = {
      title: `${report.status === "Submitted" ? "Edit" : "Complete"} daily report`,
      intro: `${job?.name || "Job"} · ${formatDate(report.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`,
      fields: [
        field("Work completed", "completedWork", `<textarea class="form-textarea" name="completedWork" placeholder="Work completed this shift" required>${escapeHtml(report.completedWork || "")}</textarea>`, true),
        field("Tool runs / field notes", "fieldNotes", `<textarea class="form-textarea" name="fieldNotes" placeholder="Runs completed, quantities, or other field notes">${escapeHtml(report.fieldNotes || "")}</textarea>`, true),
        field("Delays, incidents, or hazards", "issues", `<textarea class="form-textarea" name="issues" placeholder="Enter none if there were no issues">${escapeHtml(report.issues || "")}</textarea>`, true),
        field("Next shift plan", "nextShift", `<textarea class="form-textarea" name="nextShift" placeholder="Planned work or handoff for the next shift">${escapeHtml(report.nextShift || "")}</textarea>`, true),
      ], submit: "Save daily report",
    };
  } else if (kind === "edit-safety") {
    const safetyForm = state.safety.find((item) => item.id === recordId);
    if (!safetyForm) return;
    forms[kind] = {
      title: "Review safety form",
      intro: `${safetyForm.title} · ${shortJobName(safetyForm.jobId)}${safetyForm.workDate ? ` · ${formatDate(safetyForm.workDate)}` : ""}`,
      fields: [
        field("Responsible crew member", "owner", personSelect("owner", safetyForm.owner)),
        field("Review status", "status", `<select class="form-input" name="status"><option ${safetyForm.status === "Current" ? "selected" : ""}>Current</option><option ${safetyForm.status === "Needs review" ? "selected" : ""}>Needs review</option></select>`),
        field(safetyForm.documentName ? "Replace safety form PDF" : "Safety form PDF", "document", `<input class="form-input" type="file" name="document" accept="application/pdf"><div class="form-hint">${safetyForm.documentName ? `Attached: ${escapeHtml(safetyForm.documentName)}` : "Attach the signed safety form as a PDF. Maximum 10 MB."}</div>`, true),
        ...(safetyForm.documentPath || safetyForm.documentDataUrl
          ? [field("Attached PDF", "removeDocument", `<label class="gps-open-after-create"><input type="checkbox" name="removeDocument" value="yes"><span>Remove the attached safety form PDF</span></label>`, true)]
          : []),
        field("Hazards, controls, and review notes", "note", `<textarea class="form-textarea" name="note" placeholder="Record the hazards reviewed and controls agreed with the crew" required>${escapeHtml(safetyForm.note || "")}</textarea>`, true),
      ], submit: "Save safety review",
    };
  } else if (kind === "final-report") {
    const job = jobById(recordId);
    if (!job) return;
    forms[kind] = {
      title: "Complete final job summary",
      intro: `${job.name} · final job closeout`,
      fields: [
        field("Work completed and outcome", "completedWork", `<textarea class="form-textarea" name="completedWork" placeholder="Summarize the job scope and final outcome" required>${escapeHtml(job.finalReport?.completedWork || "")}</textarea>`, true),
        field("Outstanding items / follow-up", "outstandingItems", `<textarea class="form-textarea" name="outstandingItems" placeholder="List outstanding items or enter none">${escapeHtml(job.finalReport?.outstandingItems || "")}</textarea>`, true),
        field("Client handoff / final notes", "finalNotes", `<textarea class="form-textarea" name="finalNotes" placeholder="Handoff details, record locations, or final notes">${escapeHtml(job.finalReport?.finalNotes || "")}</textarea>`, true),
      ], submit: "Save summary & close job",
    };
  } else if (kind === "edit-scope") {
    const job = jobById(recordId);
    if (!job) return;
    const scope = job.scopeOfWork || {};
    forms[kind] = {
      title: `Scope of work · ${job.name}`,
      intro: "Define the project's objectives, included work, deliverables, exclusions, and acceptance criteria. This scope stays attached to the project workflow.",
      fields: [
        field("Project objectives", "scopeObjectives", `<textarea class="form-textarea" name="scopeObjectives" placeholder="What should this project achieve?">${escapeHtml(scope.objectives || "")}</textarea>`, true),
        field("Included work", "scopeIncludedWork", `<textarea class="form-textarea" name="scopeIncludedWork" placeholder="Describe the work and services included">${escapeHtml(scope.includedWork || "")}</textarea>`, true),
        field("Deliverables", "scopeDeliverables", `<textarea class="form-textarea" name="scopeDeliverables" placeholder="Reports, records, or other required outputs">${escapeHtml(scope.deliverables || "")}</textarea>`),
        field("Exclusions", "scopeExclusions", `<textarea class="form-textarea" name="scopeExclusions" placeholder="Work or services outside this scope">${escapeHtml(scope.exclusions || "")}</textarea>`),
        field("Acceptance criteria", "scopeAcceptanceCriteria", `<textarea class="form-textarea" name="scopeAcceptanceCriteria" placeholder="How completion and acceptance will be confirmed">${escapeHtml(scope.acceptanceCriteria || "")}</textarea>`, true),
      ], submit: "Save project scope",
    };
  } else if (kind === "edit-contractor-company") {
    const company = contractorCompaniesCache.find((item) => item.id === recordId);
    if (!company) return;
    forms[kind] = {
      title: `Company profile · ${company.name}`,
      intro: "Maintain the legal and GST / tax registration details supplied for contractor approval.",
      fields: [
        field("Registered company name", "name", `<input class="form-input" name="name" value="${escapeHtml(company.name || "")}" required>`),
        field("GST / tax registration number", "gst_number", `<input class="form-input" name="gst_number" value="${escapeHtml(company.gst_number || "")}" placeholder="GST, VAT, or business tax number">`),
        field("Business phone", "business_phone", `<input class="form-input" name="business_phone" type="tel" value="${escapeHtml(company.business_phone || "")}">`),
        field("Business address", "business_address", `<textarea class="form-textarea" name="business_address">${escapeHtml(company.business_address || "")}</textarea>`, true),
      ], submit: "Save company profile",
    };
  }
  const config = forms[kind];
  if (!config) return;
  modalContent.innerHTML = `<form id="modal-form" data-kind="${kind}" data-record-id="${escapeHtml(recordId)}"><div class="modal-inner"><div class="modal-head"><div><div class="section-kicker">WORKSPACE UPDATE</div><h2>${config.title}</h2><p class="panel-subtitle">${config.intro}</p></div><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><div class="form-grid">${config.fields.join("")}</div><div class="modal-actions"><button type="button" class="button button-outline" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">${config.submit}</button></div></div></form>`;
  modal.classList.toggle("modal-equipment", kind === "new-equipment");
  modal.showModal();
  if (kind === "new-job") {
    const form = document.getElementById("modal-form");
    refreshJobCrewSelectors(form, true);
  }
  updateContractorPricingPreview();
}

async function submitForm(form) {
  if (userProfile?.role === "foreman") {
    showToast("Foreman accounts have read-only access.");
    return;
  }
  const data = new FormData(form);
  const value = (key) => String(data.get(key) || "").trim();
  const record = { id: uid() };
  const openGpsWorkspaceAfterSave = form.dataset.kind === "new-job" && data.get("openGpsWorkspace") === "yes";
  if (form.dataset.kind === "configure-contractor-workflow") {
    const companyId = form.dataset.recordId;
    const rates = Object.fromEntries(["hourly_rate", "subsistence_daily_rate", "truck_daily_rate", "utv_daily_rate", "atv_daily_rate", "snowmobile_daily_rate"]
      .map((key) => [key, Number(value(key))]));
    const { error } = await supabaseClient.rpc("admin_configure_contractor_workflow", {
      p_company_id: companyId,
      p_rates: rates,
      p_job_ids: data.getAll("job_ids").map(String),
      p_equipment_ids: data.getAll("equipment_ids").map(String),
    });
    if (error) {
      console.error("Could not save contractor rates or assignments.", error);
      showToast(error.message || "Could not save contractor workflow settings.");
      return;
    }
    modal.close();
    await loadAdminContractorWorkflow();
    showToast("Contractor rates and job assignments saved.");
    return;
  }
  if (form.dataset.kind === "add-contractor-equipment") {
    const { error } = await supabaseClient.from("contractor_company_equipment").insert({
      company_id: form.dataset.recordId,
      equipment_type: value("equipment_type"),
      name: value("name"),
      serial_number: value("serial_number"),
    });
    if (error) {
      console.error("Could not register contractor equipment.", error);
      showToast(error.message || "Could not register contractor equipment.");
      return;
    }
    modal.close();
    await loadAdminContractorWorkflow();
    showToast("Contractor-owned equipment registered.");
    return;
  }
  if (form.dataset.kind === "new-contractor-invoice") {
    const equipmentUsage = [...data.entries()]
      .filter(([key, days]) => key.startsWith("equipmentDays_") && Number(days) > 0)
      .map(([key, days]) => ({ equipment_id: key.slice("equipmentDays_".length), days: Number(days) }));
    const { error } = await supabaseClient.rpc("submit_contractor_invoice", {
      p_job_id: value("job_id"),
      p_invoice_number: value("invoice_number"),
      p_work_date: value("work_date"),
      p_labor_hours: Number(value("labor_hours") || 0),
      p_subsistence_days: Number(value("subsistence_days") || 0),
      p_equipment_usage: equipmentUsage,
      p_notes: value("notes"),
    });
    if (error) {
      console.error("Could not submit contractor invoice.", error);
      showToast(error.message || "Could not submit contractor invoice.");
      return;
    }
    modal.close();
    await loadContractorWorkflow();
    renderPage();
    showToast("Invoice submitted for admin review.");
    return;
  }
  if (form.dataset.kind === "new-employee-invite") {
    const { data: inviteData, error } = await supabaseClient.rpc("create_contractor_employee_invite", { p_email: value("email") });
    if (error) {
      console.error("Could not create contractor employee invitation.", error);
      showToast(error.message || "Could not create the employee invitation.");
      return;
    }
    const invite = Array.isArray(inviteData) ? inviteData[0] : inviteData;
    if (!invite?.token) {
      console.error("The contractor invitation response did not contain a token.", inviteData);
      showToast("Invitation was created, but the link could not be generated. Refresh and check your invitations.");
      return;
    }
    const inviteUrl = new URL(location.href);
    inviteUrl.searchParams.set("contractorInvite", invite.token);
    modal.close();
    try {
      await navigator.clipboard.writeText(inviteUrl.toString());
      showToast("Invitation link copied. Share it with the invited employee.");
    } catch (error) {
      console.error("Could not copy the contractor invitation link.", error);
      window.prompt("Copy this employee invitation link:", inviteUrl.toString());
      showToast("Invitation created. Copy and share the link shown.");
    }
    return;
  }
  switch (form.dataset.kind) {
    case "new-task":
      record.title = value("title");
      record.assignee = value("assignee");
      record.jobIds = data.getAll("jobIds").map(String);
      record.due = value("due");
      record.priority = value("priority") || "Normal";
      record.done = false;
      state.tasks.unshift(record);
      break;
    case "assign-foreman": {
      const job = jobById(form.dataset.recordId);
      const foreman = foremanProfilesCache.find((profile) => profile.id === value("foremanUserId"));
      if (!job || (value("foremanUserId") && !foreman)) {
        showToast("Select a valid approved foreman account.");
        return;
      }
      job.foremanUserId = foreman?.id || "";
      job.foremanName = foremanProfileName(foreman);
      break;
    }
    case "new-job":
      {
        const startDate = value("startDate");
        const endDate = value("endDate");
        if (!startDate || !endDate || endDate < startDate) {
          showToast("The job end date must be on or after its start date.");
          return;
        }
        const latitudeValue = value("siteLatitude");
        const longitudeValue = value("siteLongitude");
        if (Boolean(latitudeValue) !== Boolean(longitudeValue)) {
          showToast("Enter both project coordinates or leave both blank.");
          return;
        }
        let siteCoordinate = null;
        if (latitudeValue && longitudeValue) {
          try {
            siteCoordinate = window.GPSCalculations.inspectCoordinate(latitudeValue, longitudeValue);
          } catch (error) {
            showToast(error.message || "Enter valid project GPS coordinates.");
            return;
          }
        }
        const client = state.clients.find((item) => item.id === value("client"));
        if (!client) {
          showToast("Select a registered client. Add the client in the Admin panel if it is missing.");
          return;
        }
        const companyId = value("companyId");
        const company = jobAssignmentCompanies().find((item) => item.id === companyId);
        const foreman = foremanProfilesCache.find((profile) => profile.id === value("foremanUserId"));
        const crewLead = foremanProfileName(foreman);
        const crewMembers = [...new Set(data.getAll("crewMembers").map((person) => String(person).trim()).filter((person) => person && person !== crewLead))];
        const companyRoster = workspaceCrewRoster(companyId);
        if (!company || !foreman || !crewLead) {
          showToast("Select a company and an approved foreman account.");
          return;
        }
        if (crewMembers.length > 10) {
          showToast("A job can have a foreman and up to 10 additional crew members.");
          return;
        }
        if (crewMembers.some((name) => !companyRoster.some((person) => person.name === name))) {
          showToast("Select crew members from the selected company.");
          return;
        }
        const workDays = datesBetween(startDate, endDate);
        const assignedCrew = new Set([crewLead, ...crewMembers]);
        const dailyPlan = workDays.map((date) => ({
          date,
          assignee: String(data.get(`dailyAssignee_${date}`) || "").trim(),
          tasks: String(data.get(`dailyTasks_${date}`) || "").split(/\r?\n/).map((task) => task.trim()).filter(Boolean),
        }));
        const incompleteDay = dailyPlan.find((day) => !assignedCrew.has(day.assignee) || !day.tasks.length);
        if (incompleteDay) {
          showToast(`Assign the foreman or a selected crew member and add at least one task for ${formatDate(incompleteDay.date)}.`);
          return;
        }
        Object.assign(record, {
          name: value("name"), client: client.name, clientId: client.id, location: value("location"),
          date: startDate, startDate, endDate, companyId, companyName: company.name,
          foremanUserId: foreman.id, foremanName: crewLead, crewLead, crewMembers, dailyPlan,
          ...(siteCoordinate ? {
            siteCoordinate: { lat: siteCoordinate.lat, lon: siteCoordinate.lon },
            gpsWorkspace: {
              version: 1,
              features: [{ id: uid(), type: "point", name: "Project site", lat: siteCoordinate.lat, lon: siteCoordinate.lon }],
              center: [siteCoordinate.lat, siteCoordinate.lon],
              zoom: 14,
            },
          } : {}),
          scopeOfWork: {
            objectives: value("scopeObjectives"),
            includedWork: value("scopeIncludedWork"),
            deliverables: value("scopeDeliverables"),
            exclusions: value("scopeExclusions"),
            acceptanceCriteria: value("scopeAcceptanceCriteria"),
          },
          status: value("status"), progress: 0,
        });
        state.tasks.unshift(...dailyPlan.flatMap(({ date, assignee, tasks }) => tasks.map((title) => ({
          id: uid(), title, jobIds: [record.id], assignee, due: date, priority: "Normal", done: false,
        }))));
        state.safety.unshift({
          id: uid(), title: "Job Safety Analysis (JSA)", jobId: record.id, owner: crewLead,
          updated: startDate, workDate: startDate, status: "Needs review",
          note: "Complete the job-level JSA and review hazards and controls with the crew before work starts.",
        });
        state.safety.unshift(...dailyPlan.map(({ date: workDate, assignee }) => ({
          id: uid(), title: "Daily Hazard / Loss Analysis (DHLA)", jobId: record.id, owner: assignee,
          updated: workDate, workDate, status: "Needs review",
          note: "Complete the daily hazard and loss analysis with the crew before starting this shift.",
        })));
        state.reports.unshift(...workDays.map((date) => ({
          id: uid(), jobId: record.id, date, status: "Open", completedWork: "", fieldNotes: "", issues: "", nextShift: "",
        })));
      }
      state.jobs.unshift(record);
      break;
    case "edit-scope": {
      const job = jobById(form.dataset.recordId);
      if (!job) {
        showToast("This project could not be found.");
        return;
      }
      job.scopeOfWork = {
        objectives: value("scopeObjectives"),
        includedWork: value("scopeIncludedWork"),
        deliverables: value("scopeDeliverables"),
        exclusions: value("scopeExclusions"),
        acceptanceCriteria: value("scopeAcceptanceCriteria"),
      };
      break;
    }
    case "new-run":
      Object.assign(record, { type: value("type"), date: value("date"), jobId: value("jobId"), operator: value("operator"), tool: value("tool") || "Other / not listed", status: value("status"), notes: value("notes") });
      state.runs.unshift(record);
      break;
    case "new-person":
      {
        const companyId = value("companyId");
        const company = jobAssignmentCompanies().find((item) => item.id === companyId);
        const crewMember = contractorCrewMembersCache.find((member) => member.user_id === value("userId")
          && member.company_id === companyId);
        const memberName = crewMember?.full_name || crewMember?.email || value("name");
        if (!company || !memberName) {
          showToast("Select a company and enter a crew member name or choose an approved company user.");
          return;
        }
        if (state.people.some((person) => person.companyId === companyId
          && person.name.toLowerCase() === memberName.toLowerCase())) {
          showToast("That crew member is already listed for this company.");
          return;
        }
        Object.assign(record, {
          name: memberName,
          ...(crewMember ? { userId: crewMember.user_id } : {}),
          companyId,
          role: value("role"),
          jobIds: data.getAll("jobIds").map(String),
        });
      }
      state.people.unshift(record);
      break;
    case "new-equipment": {
      const equipmentName = value("name").trim();
      const equipmentType = value("type").trim();
      const serial = value("serial").trim();
      if (!equipmentName || !equipmentType || !serial) {
        showToast("Enter an equipment name, category, and serial number.");
        return;
      }
      if (state.equipment.some((item) => item.serial?.trim().toLowerCase() === serial.toLowerCase())) {
        showToast("That serial number is already registered.");
        return;
      }
      Object.assign(record, { name: equipmentName, type: equipmentType, serial, jobId: value("jobId"), status: value("jobId") ? "Assigned" : "Available" });
      state.equipment.unshift(record);
      break;
    }
    case "new-invoice":
      record.contractorId = value("contractorId");
      record.contractor = contractorById(record.contractorId)?.name || "";
      Object.assign(record, { number: value("number"), jobId: value("jobId"), amount: Number(value("amount")), due: value("due"), status: "Pending" });
      state.invoices.unshift(record);
      break;
    case "new-contractor": {
      const name = value("name");
      if (state.contractors.some((contractor) => contractor.name.toLowerCase() === name.toLowerCase())) {
        showToast("That contractor company is already registered.");
        return;
      }
      state.contractors.unshift({ id: uid(), name, pricing: { laborRates: {}, equipmentRates: {} } });
      break;
    }
    case "new-client": {
      const name = value("name").trim();
      if (!name) {
        showToast("Enter a client name.");
        return;
      }
      if (state.clients.some((client) => client.name.toLowerCase() === name.toLowerCase())) {
        showToast("That client is already registered.");
        return;
      }
      state.clients.unshift({ id: uid(), name });
      break;
    }
    case "edit-pricing": {
      const company = contractorById(form.dataset.recordId);
      if (!company) {
        showToast("This contractor company could not be found.");
        return;
      }
      const laborRates = {};
      contractorRoles().forEach((role, index) => {
        const rawRate = value(`laborRate_${index}`);
        if (rawRate !== "") laborRates[role] = Number(rawRate);
      });
      const equipmentRates = {};
      contractorEquipmentTypes().forEach((type, index) => {
        const rawRate = value(`equipmentRate_${index}`);
        if (rawRate !== "") equipmentRates[type] = Number(rawRate);
      });
      company.pricing = { laborRates, equipmentRates };
      break;
    }
    case "new-contractor-submission": {
      const contractorId = value("contractorId");
      const company = contractorById(contractorId);
      const role = value("role");
      const hours = Number(value("hours"));
      const equipmentType = value("equipmentType");
      const equipmentQuantity = Number(value("equipmentQuantity"));
      const equipmentDays = Number(value("equipmentDays"));
      if (!company || !jobById(value("jobId"))) {
        showToast("Select a contractor company and an assigned job.");
        return;
      }
      if (hours < 0 || equipmentQuantity < 0 || equipmentDays < 0 || !Number.isFinite(hours + equipmentQuantity + equipmentDays)) {
        showToast("Hours and equipment quantities must be valid non-negative numbers.");
        return;
      }
      if (hours === 0 && (equipmentQuantity === 0 || equipmentDays === 0)) {
        showToast("Enter labor hours or equipment quantity and rental days.");
        return;
      }
      const hourlyRate = hours > 0 ? company.pricing.laborRates[role] : 0;
      const equipmentDailyRate = equipmentQuantity > 0 && equipmentDays > 0 ? company.pricing.equipmentRates[equipmentType] : 0;
      if (hours > 0 && (!role || !Number.isFinite(Number(hourlyRate)) || Number(hourlyRate) <= 0)) {
        showToast("The selected company does not have a rate for this labor role.");
        return;
      }
      if ((equipmentQuantity > 0) !== (equipmentDays > 0)) {
        showToast("Enter both equipment quantity and rental days, or leave both at zero.");
        return;
      }
      if (equipmentQuantity > 0 && (!equipmentType || !Number.isFinite(Number(equipmentDailyRate)) || Number(equipmentDailyRate) <= 0)) {
        showToast("The selected company does not have a rate for this equipment type.");
        return;
      }
      Object.assign(record, {
        contractorId, jobId: value("jobId"), date: value("date"), role, hours,
        hourlyRate: Number(hourlyRate || 0), equipmentType, equipmentQuantity, equipmentDays,
        equipmentDailyRate: Number(equipmentDailyRate || 0), notes: value("notes"), status: "Pending",
      });
      state.contractorSubmissions.unshift(record);
      break;
    }
    case "new-safety": {
      const documentFile = data.get("document");
      if (documentFile instanceof File && documentFile.size > 0 && !validateSafetyDocument(documentFile)) return;
      Object.assign(record, { title: value("title"), jobId: value("jobId"), owner: value("owner"), status: value("status"), note: value("note") || "Safety review recorded.", updated: dateOffset(0), workDate: value("workDate") || dateOffset(0) });
      if (documentFile instanceof File && documentFile.size > 0) {
        const document = await storeSafetyFormDocument(documentFile, record.jobId);
        if (!document) return;
        Object.assign(record, document);
      }
      state.safety.unshift(record);
      break;
    }
    case "edit-safety": {
      const safetyForm = state.safety.find((item) => item.id === form.dataset.recordId);
      if (!safetyForm) {
        showToast("This safety form could not be found.");
        return;
      }
      const documentFile = data.get("document");
      if (documentFile instanceof File && documentFile.size > 0 && !validateSafetyDocument(documentFile)) return;
      const previousPath = safetyForm.documentPath || "";
      if (documentFile instanceof File && documentFile.size > 0) {
        const document = await storeSafetyFormDocument(documentFile, safetyForm.jobId);
        if (!document) return;
        ["documentPath", "documentDataUrl", "documentName", "documentType", "documentSize", "documentUploadedAt"]
          .forEach((key) => { delete safetyForm[key]; });
        Object.assign(safetyForm, document);
        if (previousPath && supabaseClient) {
          const { error: removeError } = await supabaseClient.storage.from("safety-form-documents").remove([previousPath]);
          if (removeError) console.error("Could not remove the replaced safety form PDF.", removeError);
        }
      } else if (value("removeDocument") === "yes") {
        delete safetyForm.documentPath;
        delete safetyForm.documentDataUrl;
        delete safetyForm.documentName;
        delete safetyForm.documentType;
        delete safetyForm.documentSize;
        delete safetyForm.documentUploadedAt;
        if (previousPath && supabaseClient) {
          const { error: removeError } = await supabaseClient.storage.from("safety-form-documents").remove([previousPath]);
          if (removeError) console.error("Could not remove the safety form PDF.", removeError);
        }
      }
      Object.assign(safetyForm, { owner: value("owner"), status: value("status"), note: value("note"), updated: dateOffset(0) });
      break;
    }
    case "safety-template": {
      const rows = [...document.querySelectorAll("#template-field-list [data-template-field]")];
      const fields = rows.map((row) => ({
        id: row.dataset.fieldId || uid(),
        label: String(row.querySelector("[data-field-label]").value || "").trim(),
        type: row.querySelector("[data-field-type]").value || "yesno",
        required: row.querySelector("[data-field-required]").checked,
      })).filter((item) => item.label);
      if (!value("name")) {
        showToast("Give the safety form a name.");
        return;
      }
      if (!fields.length) {
        showToast("Add at least one form item.");
        return;
      }
      const hazards = templateHazardRows().map((row) => ({
        id: row.dataset.hazardId || uid(),
        name: row.querySelector("[data-hazard-name]").value.trim(),
        mitigation: row.querySelector("[data-hazard-mitigation]").value.trim(),
      })).filter((hazard) => hazard.name);
      const template = (state.safetyTemplates || []).find((item) => item.id === form.dataset.recordId);
      if (template) {
        Object.assign(template, { name: value("name"), description: value("description"), jobId: value("jobId"), fields, hazards, updated: dateOffset(0) });
      } else {
        state.safetyTemplates.unshift({ id: uid(), name: value("name"), description: value("description"), jobId: value("jobId"), fields, hazards, createdAt: dateOffset(0), createdBy: state.user });
      }
      break;
    }
    case "start-safety-form": {
      const jobIdValue = value("jobId");
      const workDate = value("date") || dateOffset(0);
      if (!jobIdValue) {
        showToast("Choose a job for this safety form.");
        return;
      }
      modal.close();
      startSafetyForm(form.dataset.recordId, jobIdValue, workDate);
      return;
    }
    case "crew-time": {
      const job = jobById(form.dataset.recordId);
      const hours = Number(value("hours") || 0);
      const overtimeHours = Number(value("overtimeHours") || 0);
      if (!job || !value("personName")) {
        showToast("Select a crew member before saving time.");
        return;
      }
      if (hours < 0 || overtimeHours < 0 || hours > 24 || overtimeHours > 24 || hours + overtimeHours <= 0) {
        showToast("Enter regular or overtime hours between 0 and 24.");
        return;
      }
      Object.assign(record, {
        jobId: job.id, kind: "crew", personName: value("personName"),
        companyId: job.companyId || "", companyName: job.companyName || "",
        date: value("date") || dateOffset(0), hours, overtimeHours, notes: value("notes"),
        submittedBy: state.user || job.crewLead || "", submittedAt: dateOffset(0), status: "Submitted",
      });
      state.timesheets.unshift(record);
      break;
    }
    case "contractor-time": {
      const job = jobById(form.dataset.recordId);
      const [companyId, ...nameParts] = String(value("personKey") || "").split("||");
      const personName = nameParts.join("||").trim();
      const hours = Number(value("hours") || 0);
      const overtimeHours = Number(value("overtimeHours") || 0);
      if (!job || !companyId || !personName) {
        showToast("Select a contractor before saving time.");
        return;
      }
      if (hours < 0 || overtimeHours < 0 || hours > 24 || overtimeHours > 24 || hours + overtimeHours <= 0) {
        showToast("Enter regular or overtime hours between 0 and 24.");
        return;
      }
      const rosterEntry = foremanJobContractors(job).find((person) => person.companyId === companyId && person.name === personName);
      Object.assign(record, {
        jobId: job.id, kind: "contractor", personName, companyId,
        companyName: rosterEntry?.companyName || foremanCompanyName(companyId) || "Contractor",
        date: value("date") || dateOffset(0), hours, overtimeHours, notes: value("notes"),
        submittedBy: state.user || job.crewLead || "", submittedAt: dateOffset(0), status: "Submitted",
      });
      state.timesheets.unshift(record);
      break;
    }
    case "foreman-task": {
      const job = jobById(form.dataset.recordId);
      if (!job || !value("title") || !value("assignee")) {
        showToast("Add a task name and assign it to a crew member.");
        return;
      }
      Object.assign(record, {
        title: value("title"), jobIds: [job.id], assignee: value("assignee"),
        due: value("due") || dateOffset(0), priority: value("priority") || "Normal", done: false,
      });
      state.tasks.unshift(record);
      break;
    }
    case "edit-timesheet": {
      const entry = (state.timesheets || []).find((item) => item.id === form.dataset.recordId);
      if (!entry) {
        showToast("That time entry could not be found.");
        return;
      }
      const hours = Number(value("hours") || 0);
      const overtimeHours = Number(value("overtimeHours") || 0);
      if (hours < 0 || overtimeHours < 0 || hours > 24 || overtimeHours > 24 || hours + overtimeHours <= 0) {
        showToast("Enter regular or overtime hours between 0 and 24.");
        return;
      }
      Object.assign(entry, { date: value("date") || entry.date, hours, overtimeHours, notes: value("notes"), updated: dateOffset(0) });
      break;
    }
    case "daily-report": {
      const report = state.reports.find((item) => item.id === form.dataset.recordId);
      if (!report) {
        showToast("This daily report could not be found.");
        return;
      }
      const job = jobById(report.jobId);
      Object.assign(report, {
        completedWork: value("completedWork"), fieldNotes: value("fieldNotes"), issues: value("issues"),
        nextShift: value("nextShift"), status: "Submitted", submittedBy: state.user || job?.crewLead || "Crew",
        submittedAt: dateOffset(0),
      });
      break;
    }
    case "final-report": {
      const job = jobById(form.dataset.recordId);
      const jobReports = state.reports.filter((report) => report.jobId === job?.id);
      if (!job || !jobReports.length || jobReports.some((report) => report.status !== "Submitted") || (job.endDate || job.date) > dateOffset(0)) {
        showToast("Submit every daily report and reach the job end date before closing out.");
        return;
      }
      job.finalReport = {
        completedWork: value("completedWork"), outstandingItems: value("outstandingItems"),
        finalNotes: value("finalNotes"), submittedBy: state.user || job.crewLead || "Crew", submittedAt: dateOffset(0),
      };
      job.status = "Complete";
      job.progress = 100;
      break;
    }
    default:
      return;
  }
  persist();
  modal.close();
  if (openGpsWorkspaceAfterSave) {
    gpsWorkspaceJobId = record.id;
    setPage("gps-workspace");
  } else {
    renderPage();
  }
  showToast("Saved to your workspace.");
}

async function logout() {
  if (!supabaseClient || logoutInProgress) return;
  const isContractor = userProfile?.role === "contractor";
  const message = !isContractor && workspaceDirty
    ? "Sign out and discard local changes that have not synced?"
    : "Sign out of this workspace?";
  if (!isContractor && !confirm(message)) return;
  logoutInProgress = true;
  const button = document.getElementById("logout-button");
  if (button) {
    button.disabled = true;
    button.textContent = "Signing out…";
  }
  try {
    const { error } = await supabaseClient.auth.signOut({ scope: "local" });
    if (error) {
      console.error("Could not sign out of Fieldwork.", error);
      showToast("Could not sign out. Please try again.");
      return;
    }
  } catch (error) {
    console.error("Could not sign out of Fieldwork.", error);
    showToast("Could not sign out. Please try again.");
  } finally {
    logoutInProgress = false;
    if (button) {
      button.disabled = false;
      button.textContent = "Sign out";
    }
  }
}

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-workspace-reload]")) { void loadPersonalWorkspaces(); return; }
  if (event.target.closest("[data-workspace-new]")) { personalWorkspaceData.selectedId = ""; renderPage(); return; }
  if (event.target.closest("[data-workspace-module-cancel]")) { personalWorkspaceData.editModuleId = ""; renderPage(); return; }
  const editWorkspaceModule = event.target.closest("[data-workspace-module-edit]");
  if (editWorkspaceModule) {
    const item = personalWorkspaceData.modules.find((module) => module.id === editWorkspaceModule.dataset.workspaceModuleEdit);
    if (!item || (item.created_by !== authSession?.user?.id && userProfile?.role !== "admin")) { showToast("You cannot edit this module."); return; }
    personalWorkspaceData.editModuleId = item.id;
    renderPage();
    return;
  }
  const deleteWorkspace = event.target.closest("[data-workspace-delete]");
  if (deleteWorkspace) { void deletePersonalWorkspaceItem("personal_workspaces", deleteWorkspace.dataset.workspaceDelete); return; }
  const deleteWorkspaceModule = event.target.closest("[data-workspace-module-delete]");
  if (deleteWorkspaceModule) { void deletePersonalWorkspaceItem("shared_workspace_modules", deleteWorkspaceModule.dataset.workspaceModuleDelete); return; }
  const safetyLibraryFolder = event.target.closest("[data-safety-library-folder]");
  if (safetyLibraryFolder) {
    if (safetyLibraryFolder.classList.contains("safety-library-folder-card")) {
      openSafetyLibraryFolder(safetyLibraryFolder.dataset.safetyLibraryFolder);
    } else {
      navigateSafetyLibraryFolder(safetyLibraryFolder.dataset.safetyLibraryFolder);
    }
    return;
  }
  const createSafetyLibraryFolderButton = event.target.closest('[data-action="safety-library-add-folder"]');
  if (createSafetyLibraryFolderButton) {
    addSafetyLibraryFolder();
    return;
  }
  const safetyLibraryView = event.target.closest("[data-safety-library-view]");
  if (safetyLibraryView) {
    void openSafetyLibraryDocument(safetyLibraryView.dataset.safetyLibraryView);
    return;
  }
  const safetyLibraryDelete = event.target.closest("[data-safety-library-delete]");
  if (safetyLibraryDelete) {
    void deleteSafetyLibraryDocument(safetyLibraryDelete.dataset.safetyLibraryDelete);
    return;
  }
  const gpsEntryMode = event.target.closest("[data-gps-entry-mode]");
  if (gpsEntryMode) {
    const form = gpsEntryMode.closest("[data-gps-calc-form]");
    if (!form) return;
    const mode = gpsEntryMode.dataset.gpsEntryMode;
    form.querySelector('input[name="entryMode"]').value = mode;
    form.querySelectorAll("[data-gps-entry-mode]").forEach((button) => {
      const active = button.dataset.gpsEntryMode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    form.querySelectorAll("[data-gps-entry-view]").forEach((view) => {
      view.hidden = view.dataset.gpsEntryView !== mode;
    });
    return;
  }
  const addGpsRow = event.target.closest("[data-gps-add-row]");
  if (addGpsRow) {
    const body = addGpsRow.closest("[data-gps-entry-view]").querySelector("tbody");
    const template = body.querySelector("[data-gps-column-row]");
    const row = template.cloneNode(true);
    const index = body.rows.length + 1;
    row.querySelector("td").textContent = index;
    row.querySelectorAll("input").forEach((input) => {
      input.value = "";
      input.setAttribute("aria-label", input.getAttribute("aria-label").replace(/\d+$/, String(index)));
    });
    body.append(row);
    return;
  }
  const gpsCalculatorTab = event.target.closest("[data-gps-calculator]");
  if (gpsCalculatorTab) {
    gpsCalculatorMode = gpsCalculatorTab.dataset.gpsCalculator;
    renderPage();
    return;
  }
  const groupToggle = event.target.closest(".nav-group-toggle");
  if (groupToggle) {
    const group = groupToggle.closest(".nav-group");
    const shouldExpand = groupToggle.getAttribute("aria-expanded") !== "true";
    document.querySelectorAll(".main-nav .nav-group").forEach((item) => {
      setExpandedNavGroup(item, item === group && shouldExpand);
    });
    return;
  }
  const biJob = event.target.closest("[data-bi-job]");
  if (biJob) {
    analyticsFilters.jobId = analyticsFilters.jobId === biJob.dataset.biJob ? "" : biJob.dataset.biJob;
    renderPage();
    return;
  }
  const biCompany = event.target.closest("[data-bi-company]");
  if (biCompany) {
    analyticsFilters.contractorId = analyticsFilters.contractorId === biCompany.dataset.biCompany ? "" : biCompany.dataset.biCompany;
    renderPage();
    return;
  }
  const pricingCompany = event.target.closest("[data-pricing-company]");
  if (pricingCompany) {
    openForm("edit-pricing", pricingCompany.dataset.pricingCompany);
    return;
  }
  const submissionDecision = event.target.closest("[data-submission-decision]");
  if (submissionDecision) {
    const submission = state.contractorSubmissions.find((item) => item.id === submissionDecision.dataset.submissionDecision);
    if (submission?.status === "Pending") {
      submission.status = submissionDecision.dataset.decision;
      persist();
      renderPage();
      showToast(submission.status === "Approved" ? "Contractor submission approved." : "Contractor submission rejected.");
    }
    return;
  }
  const invoiceSubmission = event.target.closest("[data-invoice-submission]");
  if (invoiceSubmission) {
    const submission = state.contractorSubmissions.find((item) => item.id === invoiceSubmission.dataset.invoiceSubmission);
    if (!submission || submission.status !== "Approved" || submission.invoiceId) return;
    const amount = contractorSubmissionAmount(submission);
    if (amount <= 0) {
      showToast("This submission has no billable charges.");
      return;
    }
    const company = contractorById(submission.contractorId);
    const invoice = {
      id: uid(), contractorId: submission.contractorId, contractor: company?.name || "",
      number: `CW-${submission.id.slice(-6).toUpperCase()}`, jobId: submission.jobId,
      amount, due: dateOffset(14), status: "Pending", submissionId: submission.id,
    };
    state.invoices.unshift(invoice);
    submission.invoiceId = invoice.id;
    submission.status = "Invoiced";
    persist();
    renderPage();
    showToast("Invoice created from approved contractor usage.");
    return;
  }
  const fillTemplate = event.target.closest("[data-fill-template]");
  if (fillTemplate) {
    if (fillTemplate.dataset.jobId) startSafetyForm(fillTemplate.dataset.fillTemplate, fillTemplate.dataset.jobId);
    else openForm("start-safety-form", fillTemplate.dataset.fillTemplate);
    return;
  }
  const deleteTemplate = event.target.closest("[data-delete-template]");
  if (deleteTemplate) {
    const template = (state.safetyTemplates || []).find((item) => item.id === deleteTemplate.dataset.deleteTemplate);
    if (!template) return;
    if (!confirm(`Delete the safety form template “${template.name}”? Signed records are kept.`)) return;
    state.safetyTemplates = state.safetyTemplates.filter((item) => item.id !== template.id);
    persist();
    renderPage();
    showToast("Safety form template deleted.");
    return;
  }
  const removeTemplateField = event.target.closest("[data-remove-template-field]");
  if (removeTemplateField) {
    removeTemplateField.closest("[data-template-field]")?.remove();
    return;
  }
  const removeTemplateHazard = event.target.closest("[data-remove-template-hazard]");
  if (removeTemplateHazard) {
    removeTemplateHazard.closest("[data-template-hazard]")?.remove();
    return;
  }
  const removeSignature = event.target.closest("[data-remove-signature]");
  if (removeSignature) {
    if (!safetyFormDraft) return;
    safetyFormDraft.signatures.splice(Number(removeSignature.dataset.removeSignature), 1);
    refreshSafetySignatureList();
    return;
  }
  const printSafety = event.target.closest("[data-print-safety-record]");
  if (printSafety) {
    printSafetyRecord(printSafety.dataset.printSafetyRecord);
    return;
  }
  const safetyDocument = event.target.closest("[data-safety-document-form]");
  if (safetyDocument) {
    const form = state.safety.find((item) => item.id === safetyDocument.dataset.safetyDocumentForm);
    void openSafetyFormDocument(form);
    return;
  }
  const timesheetEntry = event.target.closest("[data-timesheet]");
  if (timesheetEntry) {
    openForm("edit-timesheet", timesheetEntry.dataset.timesheet);
    return;
  }
  const deleteTimesheet = event.target.closest("[data-delete-timesheet]");
  if (deleteTimesheet) {
    const entry = (state.timesheets || []).find((item) => item.id === deleteTimesheet.dataset.deleteTimesheet);
    if (!entry) {
      showToast("That time entry could not be found.");
      return;
    }
    if (!confirm(`Delete ${entry.personName}'s ${formatDate(entry.date)} time entry?`)) return;
    state.timesheets = state.timesheets.filter((item) => item.id !== entry.id);
    persist();
    renderPage();
    showToast("Time entry deleted.");
    return;
  }
  const safetyForm = event.target.closest("[data-safety-form]");
  if (safetyForm) {
    openForm("edit-safety", safetyForm.dataset.safetyForm);
    return;
  }
  const dailyReport = event.target.closest("[data-daily-report]");
  if (dailyReport) {
    openForm("daily-report", dailyReport.dataset.dailyReport);
    return;
  }
  const finalizeJob = event.target.closest("[data-finalize-job]");
  if (finalizeJob) {
    openForm("final-report", finalizeJob.dataset.finalizeJob);
    return;
  }
  const scopeJob = event.target.closest("[data-scope-job]");
  if (scopeJob) {
    openForm("edit-scope", scopeJob.dataset.scopeJob);
    return;
  }
  const openGpsWorkspace = event.target.closest('[data-action="open-gps-workspace"]');
  if (openGpsWorkspace) {
    gpsWorkspaceJobId = openGpsWorkspace.dataset.jobId;
    setPage("gps-workspace");
    return;
  }
  const assistantPrompt = event.target.closest("[data-assistant-prompt]");
  if (assistantPrompt) {
    submitAssistantMessage(assistantPrompt.dataset.assistantPrompt);
    return;
  }
  const confirmTask = event.target.closest("[data-confirm-assistant-task]");
  if (confirmTask) {
    confirmAssistantTask(confirmTask.dataset.confirmAssistantTask);
    return;
  }
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) { event.preventDefault(); setPage(pageButton.dataset.page); return; }
  const actionButtonElement = event.target.closest("[data-action]");
  if (actionButtonElement) {
    const action = actionButtonElement.dataset.action;
    if (action === "safety-template-new") openForm("safety-template");
    else if (action === "safety-template-edit") openForm("safety-template", actionButtonElement.dataset.templateId);
    else if (action === "add-template-field") {
      const list = document.getElementById("template-field-list");
      if (list) list.insertAdjacentHTML("beforeend", renderTemplateFieldRow({ id: uid(), label: "", type: "yesno", required: true }));
    }
    else if (action === "add-library-hazard") {
      const select = document.getElementById("hazard-library-select");
      const entry = HAZARD_LIBRARY.find((hazard) => hazard.id === select?.value);
      if (!entry) showToast("Choose a hazard from the library.");
      else if (!addTemplateHazard({ name: entry.name, mitigation: entry.mitigation })) showToast("That hazard is already on the form.");
    }
    else if (action === "add-custom-hazard") {
      const nameInput = document.getElementById("hazard-custom-name");
      const mitigationInput = document.getElementById("hazard-custom-mitigation");
      if (!String(nameInput?.value || "").trim()) showToast("Enter a name for the custom hazard.");
      else if (!addTemplateHazard({ name: nameInput.value.trim(), mitigation: String(mitigationInput?.value || "").trim() })) showToast("That hazard is already on the form.");
      else {
        nameInput.value = "";
        if (mitigationInput) mitigationInput.value = "";
      }
    }
    else if (action === "repeat-recent-hazards") repeatRecentHazards("template");
    else if (action === "analyze-jsa") {
      actionButtonElement.disabled = true;
      analyzeJsaFromModal().finally(() => { actionButtonElement.disabled = false; });
    }
    else if (action === "import-pdf-form") {
      actionButtonElement.disabled = true;
      importPdfFormFromModal()
        .catch((error) => {
          console.error("Could not import the PDF form.", error);
          showToast("Could not import this PDF form. Try again or add the form items manually.");
        })
        .finally(() => { actionButtonElement.disabled = false; });
    }
    else if (action === "add-pdf-form-fields") applyPdfFormFieldSuggestions();
    else if (action === "add-jsa-suggestions") applyJsaSuggestions();
    else if (action === "add-fill-hazard") {
      const select = document.getElementById("fill-hazard-library");
      const entry = HAZARD_LIBRARY.find((hazard) => hazard.id === select?.value);
      if (!entry) showToast("Choose a hazard from the library.");
      else if (!addDraftHazard({ name: entry.name, mitigation: entry.mitigation })) showToast("That hazard is already on the form.");
    }
    else if (action === "add-fill-custom-hazard") {
      const nameInput = document.getElementById("fill-hazard-name");
      const mitigationInput = document.getElementById("fill-hazard-mitigation");
      if (!String(nameInput?.value || "").trim()) showToast("Enter a name for the custom hazard.");
      else if (!addDraftHazard({ name: nameInput.value.trim(), mitigation: String(mitigationInput?.value || "").trim() })) showToast("That hazard is already on the form.");
      else {
        nameInput.value = "";
        if (mitigationInput) mitigationInput.value = "";
      }
    }
    else if (action === "repeat-fill-hazards") repeatRecentHazards("fill");
    else if (action === "clear-signature") signaturePad?.clear();
    else if (action === "add-signature") addSafetySignature();
    else if (action === "new-person") {
      Promise.allSettled([loadContractorCrewMembers(), loadAdminProfiles()]).then((results) => {
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length) {
          failures.forEach((result) => console.error("Could not refresh crew selector data.", result.reason));
          showToast("Some company-user data could not refresh. You can still add a crew member by name.");
        }
        openForm(action);
      });
    }
    else if (action === "new-job") {
      Promise.allSettled([loadContractorCrewMembers(), loadAdminProfiles(), loadForemanProfiles()]).then((results) => {
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length) {
          failures.forEach((result) => console.error("Could not refresh job assignment data.", result.reason));
          showToast("Some company-user data could not refresh. Check the company and crew lists before assigning this job.");
        }
        openForm(action);
      });
    }
    else if (action === "assign-foreman") {
      loadForemanProfiles()
        .then((loaded) => {
          if (loaded) openForm(action, actionButtonElement.dataset.jobId);
        })
        .catch((error) => {
          console.error("Could not load foreman assignment options.", error);
          showToast("Could not load foreman accounts. Check your connection and try again.");
        });
    }
    else if (action === "refresh-foreman-dashboard") {
      void refreshForemanWorkspace().catch((error) => {
        console.error("Could not refresh the assigned foreman dashboard.", error);
        showToast("Could not refresh assigned job data. Check your connection and try again.");
      });
    }
    else if (action.startsWith("new-")) openForm(action, actionButtonElement.dataset.jobId || "");
    else if (action === "configure-contractor-workflow") openForm(action, actionButtonElement.dataset.companyId);
    else if (action === "add-contractor-equipment") openForm(action, actionButtonElement.dataset.companyId);
    else if (action === "refresh-contractor-applications") loadAdminProfiles();
    else if (action === "delete-equipment") {
      const equipment = state.equipment.find((item) => item.id === actionButtonElement.dataset.equipmentId);
      if (!equipment) {
        showToast("That equipment could not be found.");
        return;
      }
      if (!confirm(`Delete ${equipment.name} from the equipment register? Existing tool-run history will be kept.`)) return;
      state.equipment = state.equipment.filter((item) => item.id !== equipment.id);
      persist();
      renderPage();
      openForm("new-equipment");
      showToast("Equipment deleted.");
    }
    else if (action === "refresh-contractor-workflow") loadAdminContractorWorkflow();
    else if (action === "manage-contractor-wcb") openForm(action, actionButtonElement.dataset.companyId);
    else if (["crew-time", "contractor-time", "foreman-task"].includes(action)) openForm(action, actionButtonElement.dataset.jobId);
    else if (action === "analytics-export") exportAnalyticsCsv();
    else if (action === "analytics-excel") exportAnalyticsExcel();
    else if (action === "analytics-print") printReport("analytics");
    else if (action === "reports-print") printReport("reports");
    else if (action === "print-job-report") printJobReport(actionButtonElement.dataset.jobId);
    else if (action === "invoice-excel") exportContractorInvoicesExcel();
    else if (action === "invoice-print") printReport("invoices");
    else if (action === "calendar-view") {
      if (["calendar", "gantt"].includes(actionButtonElement.dataset.view)) {
        jobScheduleView = actionButtonElement.dataset.view;
        renderPage();
      }
    }
    else if (action === "analytics-reset") {
      analyticsFilters = { start: "", end: "", jobId: "", contractorId: "" };
      renderPage();
    }
    else if (action === "close-modal") modal.close();
    else if (action === "calendar-prev") { calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1); renderPage(); }
    else if (action === "calendar-next") { calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1); renderPage(); }
    else if (action === "calendar-today") { calendarDate = new Date(today.getFullYear(), today.getMonth(), 1); renderPage(); }
    else if (action === "help") showToast("Use the menu to manage jobs, tasks, runs, people, equipment, invoices, and safety forms.");
    else if (action === "logout") void logout();
    else if (action === "sync-reload") reloadSharedWorkspace();
    else if (action === "sync-retry") {
      workspaceDirty = true;
      syncWorkspace();
    }
    return;
  }
  const companyDecision = event.target.closest("[data-company-decision]");
  if (companyDecision) {
    decideContractorCompany(companyDecision.dataset.companyId, companyDecision.dataset.companyDecision);
    return;
  }
  const memberDecision = event.target.closest("[data-member-decision]");
  if (memberDecision) {
    decideContractorMember(memberDecision.dataset.memberId, memberDecision.dataset.memberDecision);
    return;
  }
  const editCompany = event.target.closest("[data-edit-company]");
  if (editCompany) {
    openForm("edit-contractor-company", editCompany.dataset.editCompany);
    return;
  }
  const ticketQr = event.target.closest("[data-ticket-qr]");
  if (ticketQr) {
    showSafetyTicketQr(ticketQr.dataset.ticketQr);
    return;
  }
  const wcbDocument = event.target.closest("[data-wcb-document]");
  if (wcbDocument) {
    openContractorWcbLetter(wcbDocument.dataset.wcbDocument);
    return;
  }
  const ticketDelete = event.target.closest("[data-ticket-delete]");
  if (ticketDelete) {
    deleteSafetyTicket(ticketDelete.dataset.ticketDelete);
    return;
  }
  const approve = event.target.closest("[data-approve-invoice]");
  if (approve) {
    const invoice = state.invoices.find((item) => item.id === approve.dataset.approveInvoice);
    if (invoice) { invoice.status = "Approved"; persist(); renderPage(); showToast("Invoice approved."); }
  }
  const invoiceReview = event.target.closest("[data-invoice-review]");
  if (invoiceReview) {
    const notes = window.prompt("Optional note for the contractor:", "");
    if (notes === null) return;
    supabaseClient.rpc("admin_update_contractor_invoice", {
      p_invoice_id: invoiceReview.dataset.invoiceReview,
      p_status: invoiceReview.dataset.status,
      p_admin_notes: notes.trim(),
    }).then(({ error }) => {
      if (error) {
        console.error("Could not review contractor invoice.", error);
        showToast(error.message || "Could not update invoice status.");
        return;
      }
      showToast(`Invoice ${invoiceReview.dataset.status}.`);
      loadAdminContractorWorkflow();
    }).catch((error) => {
      console.error("Could not review contractor invoice.", error);
      showToast("Could not update invoice status. Try again.");
    });
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "personal-workspace-select") {
    personalWorkspaceData.selectedId = event.target.value;
    renderPage();
    return;
  }
  const safetyLibraryJob = event.target.closest("[data-safety-library-job]");
  if (safetyLibraryJob) {
    updateSafetyLibraryDocumentJob(safetyLibraryJob.dataset.safetyLibraryJob, safetyLibraryJob.value);
    return;
  }
  const jobForm = event.target.closest('#modal-form[data-kind="new-job"]');
  if (jobForm && event.target.name === "companyId") {
    refreshJobCrewSelectors(jobForm, true);
  } else if (jobForm && event.target.name === "crewMembers") {
    const container = document.getElementById("job-daily-plan");
    const previousCrew = new Set(JSON.parse(container?.dataset.selectedCrew || "[]"));
    const selectedCrew = [...event.target.selectedOptions].map((option) => option.value);
    if (selectedCrew.length > 10) {
      const addedMember = selectedCrew.find((name) => !previousCrew.has(name)) || selectedCrew[selectedCrew.length - 1];
      [...event.target.options].find((option) => option.value === addedMember).selected = false;
      showToast("Select no more than 10 additional crew members.");
    }
    refreshJobCrewSelectors(jobForm);
  } else if (jobForm && ["startDate", "endDate", "foremanUserId"].includes(event.target.name)) {
    refreshJobCrewSelectors(jobForm);
  }
  if (event.target.id === "crew-company") {
    const userSelect = document.getElementById("crew-user");
    if (userSelect) {
      userSelect.innerHTML = crewUserOptions(event.target.value);
      userSelect.disabled = !event.target.value || !contractorCrewProfiles(event.target.value).length;
    }
    return;
  }
  if (event.target.id === "contractor-invoice-job") {
    refreshContractorInvoiceEquipment(event.target.value);
    return;
  }
  if (event.target.id === "bi-start" || event.target.id === "bi-end" || event.target.id === "bi-job" || event.target.id === "bi-contractor") {
    const next = { ...analyticsFilters };
    if (event.target.id === "bi-start") next.start = event.target.value;
    if (event.target.id === "bi-end") next.end = event.target.value;
    if (event.target.id === "bi-job") next.jobId = event.target.value;
    if (event.target.id === "bi-contractor") next.contractorId = event.target.value;
    if (next.start && next.end && next.start > next.end) {
      showToast("The start date must be on or before the end date.");
      event.target.value = "";
      if (event.target.id === "bi-start") next.start = "";
      else next.end = "";
    }
    analyticsFilters = next;
    renderPage();
    return;
  }
  if (event.target.closest("#modal-form select")) updateContractorPricingPreview();
  const checkbox = event.target.closest("[data-task]");
  if (checkbox) {
    const task = state.tasks.find((item) => item.id === checkbox.dataset.task);
    if (task) { task.done = checkbox.checked; persist(); renderPage(); showToast(task.done ? "Task marked complete." : "Task reopened."); }
  }
});

document.addEventListener("keydown", (event) => {
  const biJob = event.target.closest("[data-bi-job]");
  if (biJob && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    biJob.click();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.closest("#modal-form")) updateContractorPricingPreview();
});

document.addEventListener("change", (event) => {
  if (event.target.id === "foreman-job-select") {
    foremanJobId = event.target.value;
    renderPage();
    return;
  }
  if (event.target.id === "signature-name") {
    document.getElementById("signature-custom-wrap")?.classList.toggle("hidden", event.target.value !== "__other");
    return;
  }
  const roleSelect = event.target.closest("[data-user-role]");
  if (roleSelect) changeUserRole(roleSelect.dataset.userRole, roleSelect.value);
  if (event.target.id === "signup-account-type") updateSignupAccountType();
  if (event.target.id === "gps-calculation-job") {
    gpsWorkspaceJobId = event.target.value;
    renderPage();
  }
  if (event.target.id === "gps-calculation-auto-add") gpsCalculatorAutoAdd = event.target.checked;
  if (event.target.id === "gps-workspace-job") {
    gpsWorkspaceJobId = event.target.value;
    renderPage();
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "personal-workspace-form") {
    event.preventDefault();
    void savePersonalWorkspace(event.target);
    return;
  }
  if (event.target.id === "shared-module-form") {
    event.preventDefault();
    void saveSharedWorkspaceModule(event.target);
    return;
  }
  if (event.target.id === "safety-library-upload-form") {
    event.preventDefault();
    void uploadSafetyLibraryDocument(event.target);
    return;
  }
  if (event.target.matches("[data-gps-calc-form]")) {
    event.preventDefault();
    try {
      const mode = event.target.dataset.gpsCalcForm;
      const data = new FormData(event.target);
      const output = GPSCalculations.calculate(mode, data);
      const result = event.target.querySelector(".gps-calc-output");
      result.innerHTML = output;
      if (gpsCalculatorAutoAdd) {
        const job = jobById(gpsWorkspaceJobId);
        if (job) {
          try {
            const points = GPSCalculations.mapCoordinates(mode, data);
            if (points.length) {
              const added = GPSWorkspace.addCalculatedPoints(job, points, mode);
              persist();
              result.insertAdjacentHTML("beforeend", `<p class="gps-result-summary gps-map-add-confirmation">Added ${added} calculated point${added === 1 ? "" : "s"} to <strong>${escapeHtml(job.name)}</strong>'s GPS map.</p>`);
            }
          } catch (error) {
            console.error("Could not add calculated GPS points to the job map.", error);
            showToast(error.message || "Could not add calculated points to the job map.");
          }
        }
      }
    } catch (error) {
      console.error("Could not calculate GPS values.", error);
      showToast(error.message || "Could not calculate these GPS values.");
    }
  } else if (event.target.id === "login-form") {
    event.preventDefault();
    submitAuthForm(event.target);
  } else if (event.target.id === "profile-form") {
    event.preventDefault();
    saveMyProfile(event.target);
  } else if (event.target.id === "safety-fill-form") {
    event.preventDefault();
    saveSafetyForm(event.target, event.submitter?.value === "print");
  } else if (event.target.id === "modal-form") {
    event.preventDefault();
    if (event.target.dataset.kind === "manage-contractor-wcb") {
      saveContractorWcbClearance(event.target).catch((error) => {
        console.error("Could not save contractor WCB clearance.", error);
        showToast("Could not save WCB clearance. Check your connection and storage access.");
      });
    } else if (event.target.dataset.kind === "new-safety-ticket") {
      saveSafetyTicket(event.target);
    } else if (event.target.dataset.kind === "edit-contractor-company") {
      saveContractorCompanyProfile(event.target);
    } else {
      submitForm(event.target).catch((error) => {
        console.error("Could not save contractor workflow form.", error);
        showToast("Could not save these changes. Check the connection and try again.");
      });
    }
  } else if (event.target.id === "assistant-form") {
    event.preventDefault();
    submitAssistantMessage(new FormData(event.target).get("message"));
  }
});

document.getElementById("assistant-toggle").addEventListener("click", () => setAssistantOpen(assistantPanel.classList.contains("hidden")));
document.getElementById("assistant-close").addEventListener("click", () => setAssistantOpen(false));
document.getElementById("mobile-menu").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
document.getElementById("auth-mode-toggle").addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));
document.getElementById("profile-button").addEventListener("click", () => { void logout(); });
document.getElementById("logout-button").addEventListener("click", (event) => {
  event.stopPropagation();
  void logout();
});

if (new URLSearchParams(location.search).has("contractorInvite")) setAuthMode("signup");

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("./sw.js").catch((error) => console.error("Fieldwork offline support could not be registered.", error));
}

initializeSupabase();
