/* =====================================================================
   Lifeline - front end (talks to the PHP + MySQL API)
   ===================================================================== */

const API_BASE = ".";
const POLL_MS = 5000;
const ID_REGEX = /^2\d-\d{4}-\d{3}$/;

const LS = {
    sidebar: "lifelineSidebarCollapsed",
    section: "lifelineActiveSection",
    alerts: "lifelineAlertsEnabled",
    loggedIn: "lifelineLoggedIn"
};

const STATUS_LABEL = { DISPATCHED: "Dispatched", RESPONDING: "Responding", ON_SCENE: "On-scene", RESOLVED: "Resolved" };
const STATUS_CLASS = { DISPATCHED: "dispatched", RESPONDING: "responding", ON_SCENE: "onscene", RESOLVED: "resolved" };
const NEXT_STATUS = { DISPATCHED: "RESPONDING", RESPONDING: "ON_SCENE", ON_SCENE: "RESOLVED" };

const GUEST_LOCKED_SECTIONS = new Set(["dashboard", "roster", "announcements", "training", "analytics", "profile"]);

const CONDITIONS_BY_PRIORITY = {
    RED: [
        "Cardiac Arrest / Unresponsive",
        "Severe Bleeding / Hemorrhage",
        "Difficulty Breathing / Asthma Attack",
        "Severe Allergic Reaction (Anaphylaxis)",
        "Seizure / Convulsions",
        "Chest Pain",
        "Head / Neck / Spinal Trauma",
        "Heat Stroke / Collapse",
        "Choking / Airway Obstruction"
    ],
    YELLOW: [
        "Fracture / Dislocation",
        "Deep Wound / Laceration",
        "Moderate Burn",
        "Fainting / Syncope",
        "High Fever / Severe Dehydration",
        "Sports / Blunt Impact Injury",
        "Asthma (Mild / Controlled)"
    ],
    GREEN: [
        "Minor Cut / Scrape",
        "Sprain / Strain",
        "Nosebleed",
        "Headache / Migraine",
        "Fever / Flu",
        "Dizziness / Lightheadedness",
        "Stomach Ache / Nausea",
        "Minor Bruise / Contusion"
    ]
};

const state = {
    user: null,
    meta: { buildings: [], squads: [], zones: [], types: [] },
    active: [],
    mine: [],
    recent: [],
    roster: [],
    rosterQuery: "",
    coResponders: {},
    announcements: [],
    training: { sessions: [], mine: [] },
    stats: null,
    charts: {}
};

/* =====================================================================
   HELPERS
   ===================================================================== */
let redirecting = false;
function goToLogin() {
    if (redirecting) return;
    redirecting = true;
    localStorage.removeItem(LS.loggedIn);
    window.location.replace("index.html");
}

async function api(path, opts = {}) {
    const { method = "GET", body } = opts;
    const headers = { "X-Requested-With": "lifeline" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res;
    try {
        res = await fetch(`${API_BASE}/${path}`, {
            method,
            headers,
            credentials: "same-origin",
            body: body !== undefined ? JSON.stringify(body) : undefined
        });
    } catch (e) {
        const err = new Error("Cannot reach the server. Check your connection.");
        err.network = true;
        throw err;
    }

    const rawText = await res.text();
    let data = null;
    try {
        data = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
        const cleanSnippet = rawText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
        const err = new Error(cleanSnippet || `Invalid server response (${res.status}).`);
        err.status = res.status;
        throw err;
    }

    if (!res.ok) {
        const err = new Error((data && data.error) || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = data && data.code;
        if (res.status === 401 && document.getElementById("dashboard") && !isGuest()) {
            goToLogin();
        }
        throw err;
    }

    if (!data || typeof data !== "object") {
        throw new Error("Empty response received from server.");
    }

    return data;
}

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

function timeAgo(ts) {
    if (!ts) return "—";
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60) return "Just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    return new Date(ts).toLocaleDateString();
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function isGuest() { return !state.user; }
function role() { return state.user ? state.user.role : "guest"; }
function isOfficer() { return !!state.user && (role() === "officer" || role() === "admin"); }
function isMember() { return !!state.user && role() === "member"; }
function isResponder() { return !!state.user && ["member", "officer", "admin"].includes(role()); }

function formatStudentIdInput(input) {
    if (!input) return;
    input.addEventListener("input", () => {
        const digits = input.value.replace(/\D/g, "").slice(0, 9);
        let formatted = digits;
        if (digits.length > 6) {
            formatted = `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
        } else if (digits.length > 2) {
            formatted = `${digits.slice(0, 2)}-${digits.slice(2)}`;
        }
        input.value = formatted;
    });
}

function toast(message, type = "info", duration = 4000) {
    let box = document.getElementById("toastContainer");
    if (!box) {
        box = document.createElement("div");
        box.id = "toastContainer";
        box.setAttribute("aria-live", "polite");
        document.body.appendChild(box);
    }
    const t = document.createElement("div");
    t.className = `toast toast-${type}`;
    t.textContent = message;
    box.appendChild(t);
    setTimeout(() => {
        t.classList.add("hide");
        setTimeout(() => t.remove(), 300);
    }, duration);
}

function fillSelect(select, items, placeholder) {
    if (!select) return;
    const prev = select.value;
    select.innerHTML = "";
    if (placeholder !== undefined) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = placeholder;
        select.appendChild(o);
    }
    items.forEach(it => {
        const o = document.createElement("option");
        o.value = it.id;
        o.textContent = it.name;
        select.appendChild(o);
    });
    if (prev && [...select.options].some(o => o.value === prev)) select.value = prev;
}

function lifelineConfirm({
    title = "Confirm Action",
    message = "",
    subtext = "",
    confirmText = "Confirm",
    cancelText = "Cancel",
    priority = null,
    danger = true
} = {}) {
    return new Promise(resolve => {
        const modal = document.getElementById("lifelineConfirmModal");
        const okBtn = document.getElementById("confirmModalOkBtn");
        const cancelBtn = document.getElementById("confirmModalCancelBtn");
        const badge = document.getElementById("confirmModalBadge");

        if (!modal || !okBtn || !cancelBtn) {
            resolve(window.confirm(`${message}\n\n${subtext}`.trim()));
            return;
        }

        setText("confirmModalTitle", title);
        setText("confirmModalMessage", message);
        setText("confirmModalSubtext", subtext);
        okBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;
        okBtn.className = danger ? "dispatch-button" : "primary-button";

        if (badge) {
            if (priority) {
                const pr = String(priority).toUpperCase();
                badge.textContent = pr;
                badge.className = `priority ${pr.toLowerCase()}-priority`;
                badge.style.display = "inline-block";
            } else {
                badge.style.display = "none";
            }
        }

        const cleanup = result => {
            modal.classList.remove("show");
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            modal.onclick = null;
            document.removeEventListener("keydown", onKey);
            resolve(result);
        };

        const onKey = e => {
            if (e.key === "Escape") {
                e.stopImmediatePropagation();
                cleanup(false);
            }
        };

        okBtn.onclick = () => cleanup(true);
        cancelBtn.onclick = () => cleanup(false);
        modal.onclick = e => { if (e.target === modal) cleanup(false); };
        document.addEventListener("keydown", onKey);

        modal.classList.add("show");
        okBtn.focus();
    });
}

/* =====================================================================
   GUEST EMERGENCY MODE & LOCKOUTS
   ===================================================================== */
function applyGuestAccessLocks() {
    const guest = isGuest();

    const guestTop = document.getElementById("guestTopbarControls");
    const userMenu = document.getElementById("userProfileMenuContainer");
    const guestField = document.getElementById("guestReporterField");
    if (guestTop) guestTop.style.display = guest ? "flex" : "none";
    if (userMenu) userMenu.style.display = guest ? "none" : "block";
    if (guestField) guestField.style.display = guest ? "block" : "none";

    document.querySelectorAll(".nav-item").forEach(btn => {
        const sec = btn.dataset.section;
        const locked = guest && GUEST_LOCKED_SECTIONS.has(sec);
        btn.classList.toggle("nav-locked", locked);
        let badge = btn.querySelector(".nav-lock-badge");
        if (locked) {
            if (!badge) {
                badge = document.createElement("span");
                badge.className = "nav-lock-badge";
                badge.textContent = "🔒";
                btn.appendChild(badge);
            }
        } else if (badge) {
            badge.remove();
        }
    });
}

function openLoginRequiredModal(sectionName) {
    setText("loginReqMessage",
        `${sectionName} is locked for unauthenticated guests. Sign in or register to view campus announcements, trainings, and your profile — or stay here to report an emergency.`);
    const m = document.getElementById("loginRequiredModal");
    if (m) m.classList.add("show");
}

function closeLoginRequiredModal() {
    const m = document.getElementById("loginRequiredModal");
    if (m) m.classList.remove("show");
}

/* =====================================================================
   NDRRMC-STYLE DUAL-TONE EMERGENCY BROADCAST ALARM ENGINE
   ===================================================================== */
let audioCtx = null;
let alarmRepeatTimer = null;
const knownIncidentIds = new Set();
let firstPollDone = false;

function isSoundEnabled() {
    return localStorage.getItem(LS.alerts) !== "false";
}

function getAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioCtx) audioCtx = new AudioCtx();
    return audioCtx;
}

async function unlockAudio() {
    if (!isSoundEnabled()) return;
    try {
        const ctx = getAudioContext();
        if (ctx && ctx.state === "suspended") {
            await ctx.resume();
        }
        updateAlertsButton();
    } catch (e) { /* blocked until gesture */ }
}

["pointerdown", "keydown", "touchstart"].forEach(evt => {
    document.addEventListener(evt, () => {
        if (isSoundEnabled()) unlockAudio();
    }, { passive: true });
});

function toggleSoundAlerts() {
    const next = !isSoundEnabled();
    localStorage.setItem(LS.alerts, next ? "true" : "false");
    updateAlertsButton();
    if (next) {
        unlockAudio().then(() => {
            playEmergencyAlarm("GREEN");
            toast("NDRRMC emergency alert sound enabled.", "success");
        });
    } else {
        stopAlarmLoop();
        toast("Emergency alert sound muted.", "info");
    }
}

function enableAlerts() {
    localStorage.setItem(LS.alerts, "true");
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
    }
    unlockAudio().then(() => {
        playEmergencyAlarm("YELLOW");
        toast("Sound & desktop notifications enabled.", "success");
    });
}

function updateAlertsButton() {
    const on = isSoundEnabled();
    const pill = document.getElementById("soundToggleBtn");
    if (pill) {
        pill.textContent = on ? "🔊 Sound On" : "🔇 Muted";
        pill.classList.toggle("muted", !on);
    }
    const btn = document.getElementById("enableAlertsBtn");
    if (btn) {
        const ready = on && audioCtx && audioCtx.state === "running";
        btn.style.display = ready ? "none" : "inline-block";
    }
}

function scheduleDualTone(ctx, freqA, freqB, startOffset, duration, peakGain = 0.28) {
    const start = ctx.currentTime + startOffset;
    const stop = start + duration;

    [freqA, freqB].forEach(freq => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(freq, start);

        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(1100, start);
        filter.Q.setValueAtTime(1.4, start);

        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(peakGain, start + 0.02);
        gain.gain.setValueAtTime(peakGain, stop - 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, stop);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(stop + 0.01);
    });
}

async function playEmergencyAlarm(priority = "RED") {
    if (!isSoundEnabled()) return;
    try {
        if ("vibrate" in navigator) {
            navigator.vibrate(priority === "RED" ? [400, 150, 400, 150, 700] : [300, 150, 300]);
        }

        const ctx = getAudioContext();
        if (!ctx) return;
        if (ctx.state === "suspended") {
            await ctx.resume();
        }
        if (ctx.state !== "running") return;

        // Philippine NDRRMC / WEA Emergency Alert Dual-Tone (853 Hz + 960 Hz)
        if (priority === "RED") {
            scheduleDualTone(ctx, 853, 960, 0.00, 0.55, 0.30);
            scheduleDualTone(ctx, 853, 960, 0.68, 0.24, 0.30);
            scheduleDualTone(ctx, 853, 960, 1.02, 0.24, 0.30);
            scheduleDualTone(ctx, 853, 960, 1.36, 0.65, 0.32);
        } else if (priority === "YELLOW") {
            scheduleDualTone(ctx, 853, 960, 0.00, 0.35, 0.24);
            scheduleDualTone(ctx, 853, 960, 0.48, 0.35, 0.24);
            scheduleDualTone(ctx, 853, 960, 0.96, 0.35, 0.24);
        } else {
            scheduleDualTone(ctx, 853, 960, 0.00, 0.25, 0.18);
            scheduleDualTone(ctx, 853, 960, 0.36, 0.35, 0.18);
        }
    } catch (e) {
        console.warn("Audio alarm skipped:", e);
    }
}

function showNdrrmcAlertModal(inc) {
    const modal = document.getElementById("ndrrmcModal");
    if (!modal) return;
    const pr = String(inc.priority || "RED").toUpperCase();
    const pill = document.getElementById("ndrrmcPriorityPill");
    if (pill) {
        pill.textContent = pr;
        pill.className = `priority ${pr.toLowerCase()}-priority`;
    }
    setText("ndrrmcTitle", `${pr} PRIORITY EMERGENCY DISPATCH`);
    setText("ndrrmcLocation", `📍 ${inc.building} – ${inc.room}`);
    setText(
        "ndrrmcDetails",
        `${inc.typeName ? inc.typeName + " • " : ""}Patients: ${inc.patients ?? 1} • Reported by ${inc.reporterName} (${inc.reporterId}) ${timeAgo(inc.createdAt)}. ${inc.details || ""}`
    );
    const respBtn = document.getElementById("ndrrmcRespondBtn");
    if (respBtn) {
        respBtn.onclick = () => {
            dismissNdrrmcModal();
            openNotificationItem(inc.id);
        };
    }
    modal.classList.add("show");
}

function dismissNdrrmcModal() {
    const modal = document.getElementById("ndrrmcModal");
    if (modal) modal.classList.remove("show");
}

function syncAlarmLoop() {
    const unacked = isResponder()
        ? state.active.filter(i => i.status === "DISPATCHED" && (!state.user || i.reporterId !== state.user.studentId))
        : [];

    if (unacked.length === 0 || !isSoundEnabled()) {
        stopAlarmLoop();
        return;
    }

    if (!alarmRepeatTimer) {
        alarmRepeatTimer = setInterval(() => {
            const currentUnacked = state.active.filter(i => i.status === "DISPATCHED");
            if (currentUnacked.length === 0 || !isSoundEnabled()) {
                stopAlarmLoop();
                return;
            }
            const topPriority = currentUnacked.some(i => i.priority === "RED")
                ? "RED"
                : currentUnacked.some(i => i.priority === "YELLOW") ? "YELLOW" : "GREEN";
            playEmergencyAlarm(topPriority);
        }, 8000);
    }
}

function stopAlarmLoop() {
    if (alarmRepeatTimer) {
        clearInterval(alarmRepeatTimer);
        alarmRepeatTimer = null;
    }
}

function notifyNewIncidents(active) {
    const fresh = active.filter(i => !knownIncidentIds.has(i.id));
    active.forEach(i => knownIncidentIds.add(i.id));
    if (!firstPollDone || !isResponder()) return;

    fresh
        .filter(i => i.status === "DISPATCHED" && i.reporterId !== state.user.studentId)
        .forEach(i => {
            toast(`🚨 NDRRMC ALERT (${i.priority}): ${i.building} – ${i.room}`, "error", 9000);
            playEmergencyAlarm(i.priority);
            showNdrrmcAlertModal(i);
            if ("Notification" in window && Notification.permission === "granted") {
                new Notification(`🚨 LIFELINE ${i.priority} EMERGENCY`, {
                    body: `${i.building} – ${i.room} • ${i.patients ?? 1} patient(s)`
                });
            }
        });
}

/* =====================================================================
   CLICKABLE NOTIFICATION BELL & DETAILS DRAWER
   ===================================================================== */
function toggleNotifDropdown(event) {
    if (event) event.stopPropagation();
    closeProfileDropdown();
    const menu = document.getElementById("notifDropdownMenu");
    if (menu) menu.classList.toggle("show");
}

function closeNotifDropdown() {
    const menu = document.getElementById("notifDropdownMenu");
    if (menu) menu.classList.remove("show");
}

document.addEventListener("click", function (event) {
    const notifBox = document.getElementById("notifMenuContainer");
    if (notifBox && !notifBox.contains(event.target)) closeNotifDropdown();
});

function openNotificationItem(incidentId = null) {
    closeNotifDropdown();
    showSection("emergency", true);

    requestAnimationFrame(() => {
        const target = (incidentId && document.getElementById(`dispatch-item-${incidentId}`))
            || document.getElementById("emergencyDispatchesCard");
        if (!target) return;

        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.style.transition = "box-shadow 0.3s ease, outline 0.3s ease";
        target.style.outline = "2px solid #dc2626";
        target.style.boxShadow = "0 0 0 6px rgba(220, 38, 38, 0.18)";
        setTimeout(() => {
            target.style.outline = "";
            target.style.boxShadow = "";
        }, 2200);
    });
}

function updateNotificationBell() {
    const el = document.getElementById("notifCount");
    const bellBtn = document.getElementById("notifBellBtn");
    const headerBadge = document.getElementById("notifHeaderBadge");
    const listEl = document.getElementById("notifDropdownList");

    const items = isResponder()
        ? state.active
        : state.mine.filter(i => i.status !== "RESOLVED");

    const unackedCount = isResponder()
        ? state.active.filter(i => i.status === "DISPATCHED").length
        : items.length;

    if (el) {
        el.textContent = unackedCount;
        el.style.display = unackedCount > 0 ? "flex" : "none";
    }
    if (bellBtn) {
        bellBtn.classList.toggle("has-alerts", unackedCount > 0);
    }
    if (headerBadge) {
        headerBadge.textContent = `${items.length} Active`;
    }
    if (listEl) {
        if (items.length === 0) {
            listEl.innerHTML = `<p class="empty-note" style="padding:14px 8px; text-align:center;">No active emergency alerts.</p>`;
        } else {
            listEl.innerHTML = items.map(inc => {
                const pr = esc(String(inc.priority || "RED").toLowerCase());
                const statusText = STATUS_LABEL[inc.status] || inc.status;
                return `
                <button type="button" class="notif-item ${pr}-item" onclick="openNotificationItem('${esc(inc.id)}')">
                    <div class="notif-item-top">
                        <strong>${esc(inc.id)} • ${esc(statusText)}</strong>
                        <span class="priority ${pr}-priority">${esc(inc.priority)}</span>
                    </div>
                    <p class="notif-item-loc">📍 ${esc(inc.building)} - ${esc(inc.room)}</p>
                    <p class="notif-item-meta">${inc.typeName ? esc(inc.typeName) + " • " : ""}${esc(inc.patients ?? 1)} patient(s) • ${esc(timeAgo(inc.createdAt))}</p>
                </button>`;
            }).join("");
        }
    }
}

/* =====================================================================
   PROFILE DROPDOWN
   ===================================================================== */
function toggleProfileDropdown(event) {
    if (event) event.stopPropagation();
    closeNotifDropdown();
    const menu = document.getElementById("profileDropdownMenu");
    const container = document.getElementById("userProfileMenuContainer");
    if (menu) {
        const open = menu.classList.toggle("show");
        if (container) container.classList.toggle("open", open);
    }
}

function closeProfileDropdown() {
    const menu = document.getElementById("profileDropdownMenu");
    const container = document.getElementById("userProfileMenuContainer");
    if (menu) menu.classList.remove("show");
    if (container) container.classList.remove("open");
}

document.addEventListener("click", function (event) {
    const container = document.getElementById("userProfileMenuContainer");
    if (container && !container.contains(event.target)) closeProfileDropdown();
});

/* =====================================================================
   AUTH: LOGIN & REGISTER (index.html — USER ROLE ONLY)
   ===================================================================== */
let isOtpVerified = false;

function resetOtpUi() {
    isOtpVerified = false;
    const otpSection = document.getElementById("otpSection");
    const otpStatus = document.getElementById("otpStatusMsg");
    const submitBtn = document.getElementById("regSubmitBtn");
    if (otpSection) otpSection.style.display = "none";
    if (otpStatus) otpStatus.style.display = "none";
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = "0.5";
        submitBtn.style.cursor = "not-allowed";
    }
}

function switchAuthTab(tab) {
    const loginTabBtn = document.getElementById("loginTabBtn");
    const registerTabBtn = document.getElementById("registerTabBtn");
    const loginContainer = document.getElementById("loginFormContainer");
    const registerContainer = document.getElementById("registerFormContainer");

    if (tab === "register") {
        if (loginTabBtn) loginTabBtn.classList.remove("active");
        if (registerTabBtn) registerTabBtn.classList.add("active");
        if (loginContainer) loginContainer.style.display = "none";
        if (registerContainer) registerContainer.style.display = "block";
    } else {
        if (registerTabBtn) registerTabBtn.classList.remove("active");
        if (loginTabBtn) loginTabBtn.classList.add("active");
        if (registerContainer) registerContainer.style.display = "none";
        if (loginContainer) loginContainer.style.display = "block";
    }
}

const loginForm = document.getElementById("loginForm");
if (loginForm) {
    loginForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        const studentId = document.getElementById("studentId").value.trim();
        const password = document.getElementById("password").value;
        const btn = loginForm.querySelector("button[type=submit]");

        if (!ID_REGEX.test(studentId)) {
            toast("Invalid Student ID format. Use 2X-XXXX-XXX (e.g. 23-1234-567).", "error");
            return;
        }

        btn.disabled = true;
        try {
            await api("auth.php?action=login", { method: "POST", body: { student_id: studentId, password } });
            localStorage.setItem(LS.loggedIn, "1");
            localStorage.setItem(LS.section, "dashboard");
            window.location.replace("dashboard.html");
        } catch (err) {
            if (err.code === "not_registered" || err.code === "needs_activation") {
                toast(err.message, "error", 6000);
                switchAuthTab("register");
                const reg = document.getElementById("regStudentId");
                if (reg) reg.value = studentId;
            } else {
                toast(err.message, "error");
            }
        } finally {
            btn.disabled = false;
        }
    });
}

const registerForm = document.getElementById("registerForm");
if (registerForm) {
    registerForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        const btn = registerForm.querySelector("button[type=submit]");

        const payload = {
            full_name: document.getElementById("regFullName").value.trim(),
            student_id: document.getElementById("regStudentId").value.trim(),
            course: document.getElementById("regCourse").value.trim(),
            password: document.getElementById("regPassword").value
        };

        if (!ID_REGEX.test(payload.student_id)) {
            toast("Invalid Student ID format. Use 2X-XXXX-XXX (e.g. 23-1234-567).", "error");
            return;
        }
        if (payload.password.length < 6) {
            toast("Password must be at least 6 characters.", "error");
            return;
        }

        btn.disabled = true;
        try {
            const res = await api("auth.php?action=register", { method: "POST", body: payload });
            toast(`Account created for ${res.name}. Please sign in.`, "success", 6000);
            registerForm.reset();
            resetOtpUi();
            const loginId = document.getElementById("studentId");
            if (loginId) loginId.value = payload.student_id;
            switchAuthTab("login");
        } catch (err) {
            if (err.code === "already_registered") {
                toast(err.message, "error", 6000);
                switchAuthTab("login");
                const loginId = document.getElementById("studentId");
                if (loginId) loginId.value = payload.student_id;
            } else {
                toast(err.message, "error", 6000);
            }
        } finally {
            btn.disabled = false;
        }
    });
}

async function logout() {
    stopAlarmLoop();
    localStorage.removeItem(LS.loggedIn);
    localStorage.removeItem(LS.section);
    try { await api("auth.php?action=logout", { method: "POST" }); } catch (e) { /* ignore */ }
    goToLogin();
}

async function requestOTP() {
    const studentId = document.getElementById("regStudentId").value.trim();
    if (!studentId || !ID_REGEX.test(studentId)) {
        toast("Please enter a valid Student ID first (e.g. 23-1234-567).", "error");
        return;
    }

    const btn = document.getElementById("sendOtpBtn");
    btn.disabled = true;
    try {
        const res = await api("auth.php?action=send_otp", {
            method: "POST",
            body: { student_id: studentId }
        });
        document.getElementById("otpSection").style.display = "block";
        const codeInput = document.getElementById("regOtpCode");
        if (codeInput && res.demo_otp) codeInput.value = res.demo_otp;
        toast(`OTP Sent! (Code: ${res.demo_otp})`, "success", 8000);
    } catch (err) {
        toast(err.message || "Failed to send OTP.", "error");
    } finally {
        btn.disabled = false;
    }
}

async function verifyOTP() {
    const studentId = document.getElementById("regStudentId").value.trim();
    const otpCode = document.getElementById("regOtpCode").value.trim();

    if (!otpCode || otpCode.length !== 6) {
        toast("Please enter a 6-digit OTP code.", "error");
        return;
    }

    const btn = document.getElementById("verifyOtpBtn");
    btn.disabled = true;
    try {
        const res = await api("auth.php?action=verify_otp", {
            method: "POST",
            body: { student_id: studentId, otp_code: otpCode }
        });

        if (res.verified) {
            isOtpVerified = true;
            document.getElementById("otpStatusMsg").style.display = "block";
            const submitBtn = document.getElementById("regSubmitBtn");
            submitBtn.disabled = false;
            submitBtn.style.opacity = "1";
            submitBtn.style.cursor = "pointer";
            toast("OTP verified! You may now complete your registration.", "success");
        }
    } catch (err) {
        toast(err.message || "Invalid or expired OTP code.", "error");
    } finally {
        btn.disabled = false;
    }
}

/* =====================================================================
   ROLE DASHBOARD, ADMIN DEV VIEW SWITCHER & MEDIC ON DUTY
   ===================================================================== */
let adminPreviewRole = null;

function setAdminPreviewRole(previewRole) {
    adminPreviewRole = previewRole;
    renderRoleDashboard();
    toast(`Switched presentation view to: ${previewRole.toUpperCase()}`, "info");
}

function renderRoleDashboard() {
    const u = state.user;
    if (!u) return;

    const actualRole = u.role;
    const r = (actualRole === "admin" && adminPreviewRole) ? adminPreviewRole : actualRole;

    const studentView = document.getElementById("studentDashboardView");
    const medicView = document.getElementById("medicDashboardView");
    const officerView = document.getElementById("officerDashboardView");

    const roleHeaderBadge = document.getElementById("roleHeaderBadge");
    const roleHeaderTitle = document.getElementById("roleHeaderTitle");
    const roleHeaderAction = document.getElementById("roleHeaderAction");
    const navDashText = document.getElementById("navDashText");

    const switcherHtml = actualRole === "admin" ? `
        <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            <span style="font-size:11px; font-weight:700; color:#64748b;">DEV VIEW:</span>
            <button type="button" class="secondary-button btn-xs" onclick="setAdminPreviewRole('admin')">👑 Officer/Admin</button>
            <button type="button" class="secondary-button btn-xs" onclick="setAdminPreviewRole('member')">🩺 Medic</button>
            <button type="button" class="secondary-button btn-xs" onclick="setAdminPreviewRole('student')">🎓 Student</button>
        </div>` : "";

    if (r === "officer" || r === "admin") {
        if (studentView) studentView.style.display = "none";
        if (medicView) medicView.style.display = "none";
        if (officerView) officerView.style.display = "block";

        if (roleHeaderBadge) {
            roleHeaderBadge.textContent = actualRole === "admin" ? "ADMIN / DEV COMMAND CENTER" : "DISPATCH CONTROL CENTER";
            roleHeaderBadge.style.background = "#dbeafe";
            roleHeaderBadge.style.color = "#1e40af";
        }
        if (roleHeaderTitle) roleHeaderTitle.textContent = "CPR Officer & Dispatch Command";
        if (navDashText) navDashText.textContent = actualRole === "admin" ? "Admin Console" : "Officers Panel";
        if (roleHeaderAction) roleHeaderAction.innerHTML = switcherHtml || `<button class="primary-button btn-sm" onclick="showSection('roster')">🛡️ Manage Roster</button>`;

    } else if (r === "member") {
        if (studentView) studentView.style.display = "none";
        if (officerView) officerView.style.display = "none";
        if (medicView) medicView.style.display = "block";

        if (roleHeaderBadge) {
            roleHeaderBadge.textContent = "CPR MEDIC RESPONDER VIEW";
            roleHeaderBadge.style.background = "#d1fae5";
            roleHeaderBadge.style.color = "#065f46";
        }
        if (roleHeaderTitle) roleHeaderTitle.textContent = "Active Responder Dispatch Queue";
        if (navDashText) navDashText.textContent = "Responder Hub";
        if (roleHeaderAction) roleHeaderAction.innerHTML = switcherHtml || `<button class="primary-button btn-sm" onclick="showSection('emergency')">🚨 Send Alert</button>`;

        const duty = u.dutyStatus || "On Duty";
        const isOff = duty === "Off Duty";
        setText("medicDutyTitle", isOff ? "Currently Off Duty" : `Medic ${duty}`);
        setText("medicSquadInfo", `Assigned: ${u.squad || "Alpha Team"} • ${u.zone || "Main Campus"}`);
        const dutyBtn = document.getElementById("toggleDutyBtn");
        if (dutyBtn) {
            dutyBtn.textContent = isOff ? "○ Set On Duty" : "● Set Off Duty";
            dutyBtn.style.background = isOff ? "#64748b" : "#10b981";
        }
    } else {
        if (medicView) medicView.style.display = "none";
        if (officerView) officerView.style.display = "none";
        if (studentView) studentView.style.display = "block";

        if (roleHeaderBadge) {
            roleHeaderBadge.textContent = "STUDENT EMERGENCY HUB";
            roleHeaderBadge.style.background = "#fef3c7";
            roleHeaderBadge.style.color = "#92400e";
        }
        if (roleHeaderTitle) roleHeaderTitle.textContent = "Student Safety & Emergency Assistance";
        if (navDashText) navDashText.textContent = "Student Hub";
        if (roleHeaderAction) {
            roleHeaderAction.innerHTML = switcherHtml || `
                <button class="dispatch-button" onclick="showSection('emergency')" style="padding:16px 32px; font-size:17px; font-weight:800; border-radius:12px; letter-spacing:0.3px; box-shadow:0 6px 18px rgba(220,38,38,0.28); display:inline-flex; align-items:center; gap:10px; min-height:54px;">
                    🚨 Send Emergency Request
                </button>`;
        }
    }
}

async function toggleSelfDuty() {
    if (!state.user || !isResponder()) {
        toast("Duty toggle is for CPR responders only.", "error");
        return;
    }
    try {
        await api("roster.php?action=toggle_duty", { method: "POST", body: { student_id: state.user.studentId } });
        const me = await api("auth.php?action=me");
        state.user = me.user;
        renderRoleDashboard();
        toast(`Duty status set to ${state.user.dutyStatus || "updated"}.`, "success");
        await pollTick();
    } catch (err) {
        toast(err.message, "error");
    }
}

function switchOfficerPublishTab(tab) {
    const annForm = document.getElementById("panelAnnouncementForm");
    const trnForm = document.getElementById("panelTrainingForm");
    const annBtn = document.getElementById("pubTabAnnBtn");
    const trnBtn = document.getElementById("pubTabTrnBtn");
    if (!annForm || !trnForm) return;

    const showAnn = tab === "ann";
    annForm.style.display = showAnn ? "grid" : "none";
    trnForm.style.display = showAnn ? "none" : "grid";
    if (annBtn) annBtn.classList.toggle("active", showAnn);
    if (trnBtn) trnBtn.classList.toggle("active", !showAnn);
}

/* =====================================================================
   NAVIGATION & MOBILE DRAWER
   ===================================================================== */
function ensureSidebarBackdrop() {
    let backdrop = document.getElementById("sidebarBackdrop");
    if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.id = "sidebarBackdrop";
        backdrop.className = "sidebar-backdrop";
        backdrop.addEventListener("click", closeMobileSidebar);
        document.body.appendChild(backdrop);
    }
    return backdrop;
}

function closeMobileSidebar() {
    const sidebar = document.querySelector(".sidebar");
    const backdrop = document.getElementById("sidebarBackdrop");
    if (sidebar) sidebar.classList.remove("open");
    if (backdrop) backdrop.classList.remove("show");
}

function toggleSidebarCollapse() {
    const sidebar = document.getElementById("appSidebar");
    if (sidebar) {
        sidebar.classList.toggle("collapsed");
        localStorage.setItem(LS.sidebar, sidebar.classList.contains("collapsed"));
    }
}

function toggleSidebar() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    const isOpen = sidebar.classList.toggle("open");
    const backdrop = ensureSidebarBackdrop();
    backdrop.classList.toggle("show", isOpen);
}

function showSection(sectionId, isInitialLoad = false) {
    if (!sectionId) return;

    const sectionLabels = {
        dashboard: "Dashboard",
        emergency: "Emergency Alert & Dispatch Hub",
        roster: "CPR Team & Volunteer Management",
        announcements: "Announcements",
        training: "Training & Seminars",
        analytics: "Patient Analytics",
        profile: "My Profile"
    };

    if (isGuest() && sectionId !== "emergency") {
        if (!isInitialLoad) {
            openLoginRequiredModal(sectionLabels[sectionId] || "This section");
        }
        sectionId = "emergency";
    }

    if (sectionId === "roster" && !isOfficer()) sectionId = isGuest() ? "emergency" : "dashboard";
    if (!document.getElementById(sectionId)) sectionId = isGuest() ? "emergency" : "dashboard";

    localStorage.setItem(LS.section, sectionId);

    document.querySelectorAll(".content-section").forEach(s => s.classList.remove("active-section"));
    document.getElementById(sectionId).classList.add("active-section");
    document.querySelectorAll(".nav-item").forEach(item => {
        item.classList.toggle("active", item.dataset.section === sectionId);
    });

    const subtitleMap = {
        dashboard: "Campus safety overview and emergency response dispatch hub.",
        emergency: isGuest()
            ? "Emergency dispatch is open without login. Announcements, trainings, and profile require signing in."
            : "Send emergency dispatches or respond to active campus medical calls.",
        roster: "Manage volunteer medic deployment, team assignments, and shift rosters.",
        announcements: "Important university health and safety announcements.",
        training: "CPR certification, first aid workshops, and refresher courses.",
        analytics: "Anonymized campus health and emergency statistics.",
        profile: "View and manage your personal student information."
    };

    const titleEl = document.getElementById("pageTitle");
    if (titleEl) {
        if (sectionId === "dashboard" && state.user) {
            titleEl.textContent = "Welcome back, ";
            const span = document.createElement("span");
            span.id = "welcomeUserName";
            span.textContent = state.user.name;
            titleEl.appendChild(span);
            titleEl.appendChild(document.createTextNode("!"));
        } else {
            titleEl.textContent = sectionLabels[sectionId] || "Lifeline";
        }
    }
    setText("pageSubtitle", subtitleMap[sectionId] || "");

    closeMobileSidebar();
    if (!isInitialLoad) window.scrollTo({ top: 0, behavior: "smooth" });

    if (!isGuest() && sectionId === "analytics") loadAnalytics();
    if (!isGuest() && sectionId === "training") loadTraining();
}

/* =====================================================================
   EMERGENCY DISPATCH (DYNAMIC CONDITION BY PRIORITY & ROOM DROPDOWN)
   ===================================================================== */
function updateConditionDropdownByPriority() {
    const selected = document.querySelector('input[name="priority"]:checked');
    const group = document.getElementById("incidentTypeGroup");
    const select = document.getElementById("incidentType");
    const label = document.getElementById("incidentTypeLabel");
    if (!group || !select) return;

    if (!selected) {
        group.style.display = "none";
        select.innerHTML = '<option value="">Not sure / Other</option>';
        return;
    }

    const priority = selected.value;
    const allowedNames = CONDITIONS_BY_PRIORITY[priority] || [];
    const byName = new Map(state.meta.types.map(t => [t.name.toLowerCase(), t]));

    const filtered = [];
    const seenIds = new Set();
    allowedNames.forEach(name => {
        const match = byName.get(name.toLowerCase());
        if (match && !seenIds.has(match.id)) {
            seenIds.add(match.id);
            filtered.push(match);
        }
    });

    if (label) {
        label.textContent = `${priority} Priority Condition / Complaint (optional)`;
    }
    fillSelect(select, filtered, "Not sure / Other");
    group.style.display = "block";
}

function updateRoomDropdown() {
    const buildingSelect = document.getElementById("building");
    const roomSelect = document.getElementById("room");
    if (!buildingSelect || !roomSelect) return;

    roomSelect.innerHTML = '<option value="">Select Room / Area</option>';
    const b = state.meta.buildings.find(x => String(x.id) === buildingSelect.value);
    (b ? b.rooms : []).forEach(room => {
        const option = document.createElement("option");
        option.value = room.id;
        option.textContent = room.name;
        roomSelect.appendChild(option);
    });
}

const emergencyForm = document.getElementById("emergencyForm");
if (emergencyForm) {
    emergencyForm.addEventListener("submit", async function (event) {
        event.preventDefault();

        const priority = document.querySelector('input[name="priority"]:checked');
        const buildingSel = document.getElementById("building");
        const roomSel = document.getElementById("room");
        const patients = parseInt(document.getElementById("patients").value, 10) || 1;
        const others = document.getElementById("others").value.trim();
        const typeId = document.getElementById("incidentType").value;
        const guestName = isGuest() ? (document.getElementById("guestReporterName")?.value.trim() || "") : "";

        if (!priority) { toast("Please select the emergency priority.", "error"); return; }
        if (!buildingSel.value || !roomSel.value) { toast("Please select the building and room.", "error"); return; }

        const buildingName = buildingSel.options[buildingSel.selectedIndex].text;
        const roomName = roomSel.options[roomSel.selectedIndex].text;

        const confirmed = await lifelineConfirm({
            title: "🚨 Confirm Emergency Dispatch",
            message: `Send a ${priority.value} emergency alert for ${buildingName} – ${roomName}?`,
            subtext: "False alarms delay help for real emergencies. Available CPR responders will be alerted immediately.",
            confirmText: "🚨 Send Alert Now",
            cancelText: "Cancel",
            priority: priority.value,
            danger: true
        });
        if (!confirmed) return;

        const btn = emergencyForm.querySelector(".dispatch-button");
        btn.disabled = true;
        try {
            const res = await api("incidents.php?action=create", {
                method: "POST",
                body: {
                    priority: priority.value,
                    building_id: Number(buildingSel.value),
                    room_id: Number(roomSel.value),
                    patients,
                    incident_type_id: typeId || null,
                    details: others,
                    guest_name: guestName
                }
            });

            const incident = res && res.incident;
            if (!incident) {
                throw new Error("Dispatch server did not return incident details.");
            }

            knownIncidentIds.add(incident.id);

            setText("alertMessage",
                `${incident.priority} priority emergency reported at ${incident.building} (${incident.room}). Patients: ${incident.patients ?? 1}. ` +
                `Reference ID: ${incident.id}. Available CPR responders have been notified.`);
            playEmergencyAlarm(priority.value);
            document.getElementById("alertModal").classList.add("show");

            emergencyForm.reset();
            updateConditionDropdownByPriority();
            updateRoomDropdown();
            await pollTick();
        } catch (err) {
            toast(err.message, err.code === "duplicate" ? "info" : "error", 6000);
        } finally {
            btn.disabled = false;
        }
    });
}

/* =====================================================================
   MULTI-RESPONDER DISPATCH & QUEUES
   ===================================================================== */
function getResponderList(inc) {
    const names = new Set();
    if (Array.isArray(inc.responders)) {
        inc.responders.forEach(r => {
            if (typeof r === "string" && r.trim()) names.add(r.trim());
            else if (r && r.name) names.add(String(r.name).trim());
        });
    }
    if (inc.responderName && String(inc.responderName).trim()) {
        names.add(String(inc.responderName).trim());
    }
    (state.coResponders[inc.id] || []).forEach(n => {
        if (n && String(n).trim()) names.add(String(n).trim());
    });
    return [...names];
}

function canAdvance(inc) {
    if (!isResponder() || inc.status === "RESOLVED") return false;
    return true;
}

function getDispatchActionHtml(inc, compact = false) {
    if (!canAdvance(inc)) return "";
    const next = NEXT_STATUS[inc.status];
    const responders = getResponderList(inc);
    const alreadyJoined = state.user && (
        inc.responderId === state.user.studentId ||
        responders.includes(state.user.name)
    );

    const label = {
        RESPONDING: "Accept & Respond",
        ON_SCENE: alreadyJoined ? "Mark Arrived On-Scene" : "Join & Mark On-Scene",
        RESOLVED: "Mark Resolved"
    }[next];
    const cls = { RESPONDING: "", ON_SCENE: "btn-yellow", RESOLVED: "btn-green" }[next];

    const joinBtn = (inc.status !== "DISPATCHED" && !alreadyJoined)
        ? `<button class="secondary-button btn-sm" onclick="joinDispatchTeam('${esc(inc.id)}', this)">+ Join Response</button>`
        : "";

    return `<div class="dispatch-actions" style="${compact ? "margin-top:8px;" : ""} display:flex; gap:8px; flex-wrap:wrap;">
        <button class="primary-button btn-sm ${cls}" onclick="respondToDispatch('${esc(inc.id)}', '${next}', this)">${label}</button>
        ${joinBtn}
    </div>`;
}

function formatRespondersLine(inc) {
    const list = getResponderList(inc);
    if (list.length === 0) return "";
    const label = list.length > 1 ? "Responders" : "Responder";
    return ` (${label}: ${esc(list.join(", "))})`;
}

function buildDispatchCardHtml(inc) {
    const pr = esc(String(inc.priority).toLowerCase());
    return `
    <div class="card dispatch-card ${pr}-card">
        <div class="dispatch-card-top">
            <strong>${esc(inc.id)} • ${esc(inc.reporterName)} (${esc(inc.reporterId)})</strong>
            <span class="priority ${pr}-priority">${esc(inc.priority)}</span>
        </div>
        <p class="dispatch-loc">📍 ${esc(inc.building)} - ${esc(inc.room)}</p>
        <p class="dispatch-meta">${inc.typeName ? esc(inc.typeName) + " | " : ""}Patients: ${esc(inc.patients ?? 1)}${inc.details ? " | " + esc(inc.details) : ""}</p>
        <p class="dispatch-meta">Reported ${esc(timeAgo(inc.createdAt))}</p>
        <p class="dispatch-status-line">Status: <span class="status ${STATUS_CLASS[inc.status] || "responding"}">${esc(STATUS_LABEL[inc.status] || inc.status)}</span>${formatRespondersLine(inc)}</p>
        ${getDispatchActionHtml(inc, false)}
    </div>`;
}

function renderDispatchAlerts() {
    const queueContainer = document.getElementById("responderDispatchQueue");
    const emergencyList = document.getElementById("dispatchAlertsList");
    const medicList = document.getElementById("medicDispatchAlertsList");
    const officerList = document.getElementById("officerDispatchList");

    if (queueContainer) {
        queueContainer.style.display = isResponder() ? "block" : "none";
    }
    if (!isResponder()) return;

    const active = state.active;
    const countLabel = `● ${active.length} Active Alert${active.length === 1 ? "" : "s"}`;
    setText("activeAlertCount", countLabel);
    setText("medicActiveAlertCount", `● ${active.length} Active`);

    const html = active.length === 0
        ? `<p class="empty-note">No active emergency dispatches requiring response.</p>`
        : active.map(buildDispatchCardHtml).join("");

    if (emergencyList) emergencyList.innerHTML = html;
    if (medicList) medicList.innerHTML = html;
    if (officerList) officerList.innerHTML = html;
}

function renderEmergencyDispatchesSection() {
    const listEl = document.getElementById("emergencyDispatchesList");
    const badgeEl = document.getElementById("emergencyDispatchesBadge");
    if (!listEl) return;

    const merged = new Map();
    [...state.active, ...state.mine, ...state.recent].forEach(inc => {
        if (inc && inc.id && !merged.has(inc.id)) {
            merged.set(inc.id, inc);
        }
    });

    const allDispatches = [...merged.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const activeCount = allDispatches.filter(i => i.status !== "RESOLVED").length;

    if (badgeEl) {
        badgeEl.textContent = `${activeCount} Active`;
    }

    if (allDispatches.length === 0) {
        listEl.innerHTML = `<p class="empty-note">No emergency dispatches recorded yet.</p>`;
        return;
    }

    listEl.innerHTML = allDispatches.slice(0, 10).map(inc => {
        const pr = esc(String(inc.priority || "RED").toLowerCase());
        const statusCls = STATUS_CLASS[inc.status] || "responding";
        const statusLbl = STATUS_LABEL[inc.status] || inc.status;

        return `
        <div id="dispatch-item-${esc(inc.id)}" class="card dispatch-card ${pr}-card" style="margin-bottom:10px;">
            <div class="dispatch-card-top">
                <strong>${esc(inc.id)}${inc.typeName ? " • " + esc(inc.typeName) : ""}</strong>
                <span class="priority ${pr}-priority">${esc(inc.priority)}</span>
            </div>
            <p class="dispatch-loc">📍 ${esc(inc.building)} – ${esc(inc.room)}</p>
            <p class="dispatch-meta">Patients: ${esc(inc.patients ?? 1)} • Reported ${esc(timeAgo(inc.createdAt))}${inc.reporterName ? " by " + esc(inc.reporterName) : ""}</p>
            ${inc.details ? `<p class="dispatch-meta">${esc(inc.details)}</p>` : ""}
            <p class="dispatch-status-line">Status: <span class="status ${statusCls}">${esc(statusLbl)}</span>${formatRespondersLine(inc)}</p>
            ${getDispatchActionHtml(inc, true)}
        </div>`;
    }).join("");
}

async function joinDispatchTeam(id, btn) {
    if (!isResponder() || !state.user) return;
    if (btn) btn.disabled = true;
    try {
        if (!state.coResponders[id]) state.coResponders[id] = [];
        if (!state.coResponders[id].includes(state.user.name)) {
            state.coResponders[id].push(state.user.name);
        }
        try {
            await api("incidents.php?action=join", { method: "POST", body: { id } });
        } catch (e) {
            const current = state.active.find(i => i.id === id);
            if (current && current.status !== "RESOLVED") {
                await api("incidents.php?action=advance", { method: "POST", body: { id, status: current.status } });
            }
        }
        toast(`You joined the response team for ${id}.`, "success");
    } catch (err) {
        toast(err.message, "error", 5000);
    }
    await pollTick();
}

async function respondToDispatch(id, newStatus, btn) {
    if (btn) btn.disabled = true;
    try {
        if (state.user) {
            if (!state.coResponders[id]) state.coResponders[id] = [];
            if (!state.coResponders[id].includes(state.user.name)) {
                state.coResponders[id].push(state.user.name);
            }
        }
        await api("incidents.php?action=advance", { method: "POST", body: { id, status: newStatus } });
        toast(`Incident ${id} is now ${STATUS_LABEL[newStatus]}.`, "success");
    } catch (err) {
        toast(err.message, "error", 6000);
    }
    await pollTick();
}

function renderMyRequests() {
    const pairs = [
        [document.getElementById("myRequestsCard"), document.getElementById("myRequestsList")],
        [document.getElementById("studentMyRequestsCard"), document.getElementById("studentMyRequestsList")]
    ];

    const mine = state.mine;
    const steps = ["DISPATCHED", "RESPONDING", "ON_SCENE", "RESOLVED"];
    const labels = ["Reported", "Responding", "On-scene", "Resolved"];

    const html = mine.map(inc => {
        const idx = steps.indexOf(inc.status);
        const stepper = steps.map((s, i) =>
            `<div class="dispatch-step ${i <= idx ? "active" : ""}"><span>${i + 1}</span><p>${labels[i]}</p></div>` +
            (i < steps.length - 1 ? `<div class="dispatch-line ${i < idx ? "done" : ""}"></div>` : "")
        ).join("");
        const respList = getResponderList(inc);
        const who = respList.length > 0
            ? ` • ${respList.length > 1 ? "Responders" : "Responder"}: ${esc(respList.join(", "))}`
            : " • Waiting for a responder…";
        const pr = esc(String(inc.priority).toLowerCase());
        return `
        <div class="my-request">
            <div class="my-request-head">
                <strong>${esc(inc.id)}</strong>
                <span class="priority ${pr}-priority">${esc(inc.priority)}</span>
            </div>
            <p class="dispatch-meta">${esc(inc.building)} - ${esc(inc.room)} • ${esc(timeAgo(inc.createdAt))}${inc.status === "RESOLVED" ? "" : who}</p>
            <div class="dispatch-status">${stepper}</div>
        </div>`;
    }).join("");

    pairs.forEach(([card, list]) => {
        if (!card || !list) return;
        if (mine.length === 0) {
            card.style.display = "none";
        } else {
            card.style.display = "block";
            list.innerHTML = html;
        }
    });
}

function renderDashboardStats() {
    const s = state.stats;
    if (s) {
        setText("statTodayIncidents", s.today);
        const diff = s.today - s.yesterday;
        setText("statTodayDelta", diff === 0 ? "Same as yesterday" : `${diff > 0 ? "+" : ""}${diff} from yesterday`);
        setText("activeRespondersCount", s.activeResponders);
        if (s.avgResponseMin !== null) {
            setText("statAvgResponse", `${s.avgResponseMin.toFixed(1)} min`);
            setText("statAvgNote", `From ${s.responseSamples} response${s.responseSamples === 1 ? "" : "s"} (30 days)`);
        } else {
            setText("statAvgResponse", "—");
            setText("statAvgNote", "No responses yet");
        }
        if (s.monthTotal > 0) {
            setText("statResolved", `${Math.round((s.monthResolved / s.monthTotal) * 100)}%`);
            setText("statResolvedNote", `${s.monthResolved} of ${s.monthTotal} this month`);
        } else {
            setText("statResolved", "—");
            setText("statResolvedNote", "No cases this month");
        }
    }

    const body = document.getElementById("recentIncidentsBody");
    if (body) {
        if (state.recent.length === 0) {
            body.innerHTML = `<tr><td colspan="6" class="empty-note">No incidents recorded yet.</td></tr>`;
        } else {
            body.innerHTML = state.recent.map(i => {
                const pr = esc(String(i.priority).toLowerCase());
                return `
                <tr>
                    <td>${esc(i.typeName || "Emergency")}<br><small class="muted-id">${esc(i.id)}</small></td>
                    <td>${esc(i.building)} - ${esc(i.room)}</td>
                    <td><span class="priority ${pr}-priority">${esc(i.priority)}</span></td>
                    <td>${esc(i.patients ?? 1)}</td>
                    <td><span class="status ${STATUS_CLASS[i.status] || "responding"}">${esc(STATUS_LABEL[i.status] || i.status)}</span></td>
                    <td>${esc(timeAgo(i.createdAt))}</td>
                </tr>`;
            }).join("");
        }
    }
}

function closeModal() {
    const modal = document.getElementById("alertModal");
    if (modal) modal.classList.remove("show");
}

const alertModalEl = document.getElementById("alertModal");
if (alertModalEl) alertModalEl.addEventListener("click", e => { if (e.target === alertModalEl) closeModal(); });
const ndrrmcModalEl = document.getElementById("ndrrmcModal");
if (ndrrmcModalEl) ndrrmcModalEl.addEventListener("click", e => { if (e.target === ndrrmcModalEl) dismissNdrrmcModal(); });
const loginReqModalEl = document.getElementById("loginRequiredModal");
if (loginReqModalEl) loginReqModalEl.addEventListener("click", e => { if (e.target === loginReqModalEl) closeLoginRequiredModal(); });
const profileEditModalEl = document.getElementById("profileEditModal");
if (profileEditModalEl) profileEditModalEl.addEventListener("click", e => { if (e.target === profileEditModalEl) closeProfileEdit(); });
const changePassModalEl = document.getElementById("changePasswordModal");
if (changePassModalEl) changePassModalEl.addEventListener("click", e => { if (e.target === changePassModalEl) closeChangePassword(); });
const codeModalEl = document.getElementById("codeModal");
if (codeModalEl) codeModalEl.addEventListener("click", e => { if (e.target === codeModalEl) closeCodeModal(); });

document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
        closeModal();
        dismissNdrrmcModal();
        closeProfileEdit();
        closeChangePassword();
        closeCodeModal();
        closeLoginRequiredModal();
        closeMobileSidebar();
        closeNotifDropdown();
    }
});

/* =====================================================================
   ANNOUNCEMENTS (BANNER STYLE FOR BOTH DASHBOARD & ANNOUNCEMENT BOARD)
   ===================================================================== */
function buildAnnouncementBannerHtml(ann, allowDelete = false) {
    const del = (allowDelete && isOfficer())
        ? `<button class="ann-delete" onclick="deleteAnnouncement(${Number(ann.id)})" aria-label="Delete announcement">✕</button>`
        : "";
    const badgeText = ann.featured ? "IMPORTANT" : (ann.icon ? `${ann.icon} ANNOUNCEMENT` : "IMPORTANT");
    return `
        <div class="large-announcement" style="width:100%; margin-bottom:14px;">
            ${del}
            <span class="announcement-label">${esc(badgeText)}</span>
            <h2>${esc(ann.title)}</h2>
            <p>${esc(ann.details || "")}</p>
            <span>${esc(ann.dateLabel)}</span>
        </div>`;
}

function renderAnnouncements() {
    const list = state.announcements;

    const officerCard = document.getElementById("officerAnnouncementCard");
    if (officerCard) officerCard.style.display = isOfficer() ? "block" : "none";

    const latest = document.getElementById("latestAnnouncementsList");
    if (latest) {
        const parentCard = latest.closest(".card");
        if (parentCard) parentCard.style.gridColumn = "1 / -1";
        latest.style.display = "flex";
        latest.style.flexDirection = "column";
        latest.style.gap = "12px";

        latest.innerHTML = list.length === 0
            ? `<p class="empty-note">No announcements yet.</p>`
            : list.slice(0, 3).map(ann => buildAnnouncementBannerHtml(ann, false)).join("");
    }

    const grid = document.getElementById("announcementBoardGrid");
    if (!grid) return;

    grid.innerHTML = list.length === 0
        ? `<p class="empty-note">No announcements yet.</p>`
        : list.map(ann => buildAnnouncementBannerHtml(ann, true)).join("");
}

async function loadAnnouncements() {
    const data = await api("announcements.php?action=list");
    state.announcements = data.announcements;
    renderAnnouncements();
}

async function deleteAnnouncement(id) {
    if (!isOfficer()) return;
    const confirmed = await lifelineConfirm({
        title: "Delete Announcement",
        message: "Are you sure you want to delete this announcement?",
        subtext: "This action cannot be undone.",
        confirmText: "Delete",
        cancelText: "Keep",
        danger: true
    });
    if (!confirmed) return;
    try {
        await api("announcements.php?action=delete", { method: "POST", body: { id } });
        toast("Announcement deleted.", "success");
        await loadAnnouncements();
    } catch (err) {
        toast(err.message, "error");
    }
}

async function submitAnnouncementPayload(payload, formEl) {
    if (!isOfficer()) { toast("Only CPR Officers can post announcements.", "error"); return; }
    try {
        await api("announcements.php?action=create", { method: "POST", body: payload });
        toast(`"${payload.title}" published to the Announcement Hub.`, "success");
        if (formEl) formEl.reset();
        await loadAnnouncements();
    } catch (err) {
        toast(err.message, "error");
    }
}

const createAnnouncementForm = document.getElementById("createAnnouncementForm");
if (createAnnouncementForm) {
    createAnnouncementForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        await submitAnnouncementPayload({
            title: document.getElementById("annTitle").value.trim(),
            icon: document.getElementById("annIcon").value,
            featured: document.getElementById("annFeatured").value === "true",
            date_label: document.getElementById("annDate").value.trim(),
            details: document.getElementById("annDetails").value.trim()
        }, createAnnouncementForm);
    });
}

const panelAnnouncementForm = document.getElementById("panelAnnouncementForm");
if (panelAnnouncementForm) {
    panelAnnouncementForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        await submitAnnouncementPayload({
            title: document.getElementById("panelAnnTitle").value.trim(),
            icon: document.getElementById("panelAnnIcon").value,
            featured: document.getElementById("panelAnnFeatured").value === "true",
            date_label: document.getElementById("panelAnnDate").value.trim(),
            details: document.getElementById("panelAnnDetails").value.trim()
        }, panelAnnouncementForm);
    });
}

/* =====================================================================
   CPR ROSTER, LIVE SEARCH BAR & MEDIC ON DUTY
   ===================================================================== */
function ensureRosterSearchBar() {
    const tbody = document.getElementById("cprRosterTableBody");
    if (!tbody) return null;

    let input = document.getElementById("rosterSearchInput");
    if (!input) {
        const tableWrapper = tbody.closest(".table-wrapper");
        const container = tableWrapper ? tableWrapper.parentElement : tbody.parentElement;
        if (container) {
            const bar = document.createElement("div");
            bar.id = "rosterSearchBarWrapper";
            bar.style.cssText = "display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap; margin:12px 0;";
            bar.innerHTML = `
                <div style="position:relative; flex:1; min-width:240px;">
                    <input type="search" id="rosterSearchInput" placeholder="🔍 Search CPR roster by name, Student ID, team, zone, or status..." style="width:100%; padding:10px 14px; border:1px solid #cbd5e1; border-radius:8px; font-size:14px;">
                </div>
                <span id="rosterSearchCount" style="font-size:12px; font-weight:600; color:#64748b;"></span>
            `;
            container.insertBefore(bar, tableWrapper || tbody);
            input = document.getElementById("rosterSearchInput");
        }
    }

    if (input && !input.dataset.bound) {
        input.dataset.bound = "1";
        input.addEventListener("input", () => {
            state.rosterQuery = input.value.trim().toLowerCase();
            renderCPRRoster();
        });
    }
    return input;
}

function renderSquadOverview() {
    const box = document.getElementById("squadOverviewList");
    if (!box) return;
    box.innerHTML = state.meta.squads.map(s => `
        <div style="padding:12px; background:#f8f9fb; border-radius:8px; border-left:4px solid ${esc(s.color)};">
            <strong style="font-size:13px; display:block;">${esc(s.name)} • ${esc(s.label)}</strong>
            <span style="font-size:11px; color:var(--muted);">Coverage: ${esc(s.coverage)}</span>
        </div>`).join("");
}

function renderCPRRoster() {
    const roster = state.roster;
    const tbody = document.getElementById("cprRosterTableBody");
    const emergencyResponders = document.getElementById("dynamicRespondersList");
    const medicResponders = document.getElementById("medicRespondersList");
    const officerRoster = document.getElementById("officerRosterList");

    if (tbody && isOfficer()) {
        ensureRosterSearchBar();
        const q = (state.rosterQuery || "").trim().toLowerCase();
        const filteredRoster = q
            ? roster.filter(m => {
                const haystack = [
                    m.name,
                    m.studentId,
                    m.squadName,
                    m.zone,
                    m.status,
                    m.role
                ].filter(Boolean).join(" ").toLowerCase();
                return haystack.includes(q);
            })
            : roster;

        setText("rosterSearchCount", q
            ? `Showing ${filteredRoster.length} of ${roster.length} responders`
            : `${roster.length} total responders`);

        if (filteredRoster.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-note">No CPR members match "${esc(state.rosterQuery)}".</td></tr>`;
        } else {
            tbody.innerHTML = filteredRoster.map(m => {
                let statusColor = "available";
                if (m.status === "Responding" || m.status === "On-Scene") statusColor = "busy";
                if (m.status === "Off Duty") statusColor = "status-dot";
                const options = state.meta.squads.map(s =>
                    `<option value="${s.id}" ${s.id === m.squadId ? "selected" : ""}>${esc(s.name)}</option>`).join("");
                const roleTag = (m.role === "officer" || m.role === "admin")
                    ? ` <small class="muted-id">(${m.role === "admin" ? "Admin" : "Officer"})</small>`
                    : "";
                return `
                <tr>
                    <td><strong>${esc(m.name)}</strong>${roleTag}${m.activated === false ? ' <small class="muted-id">(not activated)</small>' : ""}</td>
                    <td><code>${esc(m.studentId)}</code></td>
                    <td><select class="roster-select" onchange="updateMedicSquad('${esc(m.studentId)}', this.value)">${options}</select></td>
                    <td>${esc(m.zone)}</td>
                    <td><span class="${statusColor}">● ${esc(m.status)}</span></td>
                    <td><button class="secondary-button btn-xs" onclick="toggleMedicDuty('${esc(m.studentId)}')">Toggle Duty</button></td>
                </tr>`;
            }).join("");
        }
    }

    const activeMedics = roster.filter(m =>
        ["member", "officer", "admin"].includes(m.role) &&
        ["On Duty", "Responding", "On-Scene"].includes(m.status)
    );
    const medicsHtml = activeMedics.length === 0
        ? `<p class="empty-note">No CPR responders are on duty right now.</p>`
        : activeMedics.map(m => {
            const initials = (m.name || "?").split(" ").filter(Boolean).map(n => n[0]).join("").substring(0, 2).toUpperCase();
            const badge = (m.status === "Responding" || m.status === "On-Scene") ? "busy" : "available";
            const title = m.role === "admin" ? "Admin / Dev" : (m.role === "officer" ? "CPR Officer" : "CPR Medic");
            return `
            <div class="responder">
                <div class="responder-avatar">${esc(initials)}</div>
                <div class="responder-details">
                    <strong>${esc(m.name)} ${m.isSelf ? '<small class="self-tag">(You)</small>' : ""}</strong>
                    <span>${title} • ${esc(m.squadName)}</span>
                </div>
                <span class="${badge}">● ${esc(m.status)}</span>
            </div>`;
        }).join("");

    if (emergencyResponders) emergencyResponders.innerHTML = medicsHtml;
    if (medicResponders) medicResponders.innerHTML = medicsHtml;
    if (officerRoster) officerRoster.innerHTML = medicsHtml;
    setText("activeRespondersBadge", `${activeMedics.length} Online`);
}

async function updateMedicSquad(studentId, squadId) {
    if (!isOfficer()) return;
    try {
        await api("roster.php?action=set_squad", { method: "POST", body: { student_id: studentId, squad_id: Number(squadId) } });
        toast("Squad updated.", "success");
        await pollTick();
    } catch (err) {
        toast(err.message, "error");
    }
}

async function toggleMedicDuty(studentId) {
    if (!isOfficer()) return;
    try {
        await api("roster.php?action=toggle_duty", { method: "POST", body: { student_id: studentId } });
        await pollTick();
    } catch (err) {
        toast(err.message, "error");
    }
}

function closeCodeModal() {
    const m = document.getElementById("codeModal");
    if (m) m.classList.remove("show");
}

const addMemberForm = document.getElementById("addMemberForm");
if (addMemberForm) {
    addMemberForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        if (!isOfficer()) { toast("Only CPR Officers can add members.", "error"); return; }

        const name = document.getElementById("newMemberName").value.trim();
        const id = document.getElementById("newMemberId").value.trim();
        if (!ID_REGEX.test(id)) { toast("Invalid Student ID format.", "error"); return; }

        try {
            const res = await api("roster.php?action=add", {
                method: "POST",
                body: {
                    student_id: id,
                    full_name: name,
                    role: document.getElementById("newMemberRole").value,
                    squad_id: Number(document.getElementById("newMemberTeam").value),
                    zone_id: Number(document.getElementById("newMemberZone").value)
                }
            });
            addMemberForm.reset();
            if (res.activationCode) {
                setText("codeModalText", `${name} (${id}) was added. They must activate their account with this one-time code:`);
                setText("codeModalCode", res.activationCode);
                document.getElementById("codeModal").classList.add("show");
            } else {
                toast(`${name || id} added to the CPR roster. They can sign in with their existing password.`, "success", 6000);
            }
            await pollTick();
        } catch (err) {
            toast(err.message, "error", 6000);
        }
    });
}

/* =====================================================================
   TRAINING & SEMINARS
   ===================================================================== */
async function loadTraining() {
    try {
        state.training = await api("training.php?action=list");
        renderTraining();
    } catch (err) {
        if (!err.network) toast(err.message, "error");
    }
}

function renderTraining() {
    const officerTrnCard = document.getElementById("officerTrainingCard");
    if (officerTrnCard) officerTrnCard.style.display = isOfficer() ? "block" : "none";

    const grid = document.getElementById("trainingGrid");
    if (grid) {
        const sessions = state.training.sessions;
        grid.innerHTML = sessions.length === 0
            ? `<p class="empty-note">No upcoming training sessions yet.</p>`
            : sessions.map(s => {
                const left = Math.max(0, s.slots - s.taken);
                let btn;
                if (s.myStatus === "Registered") {
                    btn = `<button class="secondary-button" onclick="cancelTraining(${s.id})">✓ Registered – Cancel</button>`;
                } else if (s.myStatus === "Attended") {
                    btn = `<button class="secondary-button" disabled>✓ Attended</button>`;
                } else if (left === 0) {
                    btn = `<button class="secondary-button" disabled>Full</button>`;
                } else {
                    btn = `<button class="secondary-button" onclick="registerTraining(${s.id})">Register</button>`;
                }
                return `
                <div class="card training-card"><span class="training-tag">${esc(s.tag)}</span>
                    <h3>${esc(s.title)}</h3><p>${esc(s.description)}</p>
                    <div class="training-info">📅 ${esc(s.date)}</div>
                    <div class="training-info">📍 ${esc(s.location)}</div>
                    <div class="training-info">👥 ${left} of ${s.slots} Slots left</div>
                    ${btn}</div>`;
            }).join("");
    }

    const att = document.getElementById("attendanceList");
    if (att) {
        const mine = state.training.mine;
        att.innerHTML = mine.length === 0
            ? `<p class="empty-note">You have not registered for any training yet.</p>`
            : mine.map(r => {
                const done = r.status === "Attended";
                const label = done ? "Completed" : r.status === "Absent" ? "Missed" : "Upcoming";
                return `
                <div class="attendance-row"><div><strong>${esc(r.title)}</strong><span>${label} • ${esc(r.date)}</span></div>
                <div class="progress"><div class="progress-bar ${done ? "completed" : "upcoming"}"></div></div>
                <strong>${done ? "100%" : "0%"}</strong></div>`;
            }).join("");
    }
}

async function submitTrainingPayload(payload, formEl) {
    if (!isOfficer()) { toast("Only CPR Officers can announce trainings or seminars.", "error"); return; }
    try {
        await api("training.php?action=create_session", { method: "POST", body: payload });
        toast(`"${payload.title}" published to Trainings & Seminars.`, "success");
        if (formEl) formEl.reset();
        await loadTraining();
    } catch (err) {
        toast(err.message, "error");
    }
}

const createTrainingForm = document.getElementById("createTrainingForm");
if (createTrainingForm) {
    createTrainingForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        await submitTrainingPayload({
            title: document.getElementById("trnTitle").value.trim(),
            tag: document.getElementById("trnTag").value,
            session_date: document.getElementById("trnDate").value,
            location: document.getElementById("trnLocation").value.trim(),
            slots: Number(document.getElementById("trnSlots").value),
            description: document.getElementById("trnDesc").value.trim()
        }, createTrainingForm);
    });
}

const panelTrainingForm = document.getElementById("panelTrainingForm");
if (panelTrainingForm) {
    panelTrainingForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        await submitTrainingPayload({
            title: document.getElementById("panelTrnTitle").value.trim(),
            tag: document.getElementById("panelTrnTag").value,
            session_date: document.getElementById("panelTrnDate").value,
            location: document.getElementById("panelTrnLocation").value.trim(),
            slots: Number(document.getElementById("panelTrnSlots").value),
            description: document.getElementById("panelTrnDesc").value.trim()
        }, panelTrainingForm);
    });
}

async function registerTraining(id) {
    try {
        await api("training.php?action=register", { method: "POST", body: { session_id: id } });
        toast("You are registered for this session.", "success");
    } catch (err) {
        toast(err.message, "error");
    }
    loadTraining();
}

async function cancelTraining(id) {
    const confirmed = await lifelineConfirm({
        title: "Cancel Training Registration",
        message: "Cancel your registration for this training session?",
        subtext: "Your slot will be released for other students.",
        confirmText: "Yes, Cancel Slot",
        cancelText: "Keep Registration",
        danger: false
    });
    if (!confirmed) return;
    try {
        await api("training.php?action=cancel", { method: "POST", body: { session_id: id } });
        toast("Registration cancelled.", "success");
    } catch (err) {
        toast(err.message, "error");
    }
    loadTraining();
}

/* =====================================================================
   ANALYTICS (2 COMPACT CHARTS)
   ===================================================================== */
function upsertChart(key, canvasId, config) {
    if (typeof Chart === "undefined") return;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (state.charts[key]) {
        state.charts[key].data = config.data;
        state.charts[key].update();
    } else {
        state.charts[key] = new Chart(canvas, config);
    }
}

async function loadAnalytics() {
    let d;
    try {
        d = await api("analytics.php");
    } catch (err) {
        if (!err.network) toast(err.message, "error");
        return;
    }

    setText("anTotal", d.total);
    setText("anCommon", d.mostCommon ? d.mostCommon.name : "—");
    setText("anCommonNote", d.mostCommon ? `${d.mostCommon.count} cases` : "No data yet");
    setText("anResponse", d.avgResponseMin !== null ? `${d.avgResponseMin.toFixed(1)}m` : "—");
    setText("anActive", d.activeResponders);

    const monthLabels = d.months.map(m => m.label);
    upsertChart("type", "incidentChart", {
        type: "doughnut",
        data: { labels: d.byType.map(t => t.name), datasets: [{ data: d.byType.map(t => t.count) }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }
    });
    upsertChart("monthly", "monthlyChart", {
        type: "line",
        data: { labels: monthLabels, datasets: [{ label: "Incidents", data: d.months.map(m => m.count), tension: 0.3, fill: false }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
}

/* =====================================================================
   PROFILE & CHANGE PASSWORD
   ===================================================================== */
function renderProfile() {
    const u = state.user;
    if (!u) return;

    const initials = u.name.split(" ").filter(Boolean).map(n => n[0]).join("").substring(0, 2).toUpperCase() || "UD";
    const roleNames = { member: "CPR Member", officer: "CPR Officer", admin: "Administrator" };
    const roleName = roleNames[u.role] || "Student / User";

    setText("headerUserName", u.name);
    setText("headerAvatar", initials);
    setText("headerUserRole", roleName);
    setText("profileFullName", u.name);
    setText("profileAvatar", initials);
    setText("profileRoleBadge", u.squad ? `${roleName} • ${u.squad}` : roleName);
    setText("profileStudentId", u.studentId);
    setText("profileCourse", u.course);
    setText("profileBirthdate", u.birthdate
        ? new Date(u.birthdate + "T00:00:00").toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" })
        : "Not set");
    setText("profileAddress", u.address || "Not set");
    setText("profileEmergency", u.emergencyContact || "Not set");

    const cprNav = document.getElementById("cprRosterNavBtn");
    if (cprNav) cprNav.style.display = isOfficer() ? "flex" : "none";
}

function openProfileEdit() {
    const u = state.user;
    if (!u) return;
    document.getElementById("editCourse").value = u.course || "";
    document.getElementById("editBirthdate").value = u.birthdate || "";
    document.getElementById("editAddress").value = u.address || "";
    document.getElementById("editContact").value = u.emergencyContact || "";
    document.getElementById("profileEditModal").classList.add("show");
}

function closeProfileEdit() {
    const m = document.getElementById("profileEditModal");
    if (m) m.classList.remove("show");
}

const profileEditForm = document.getElementById("profileEditForm");
if (profileEditForm) {
    profileEditForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        try {
            const { user } = await api("auth.php?action=update_profile", {
                method: "POST",
                body: {
                    course: document.getElementById("editCourse").value,
                    birthdate: document.getElementById("editBirthdate").value,
                    address: document.getElementById("editAddress").value,
                    emergency_contact: document.getElementById("editContact").value
                }
            });
            state.user = user;
            renderProfile();
            renderRoleDashboard();
            closeProfileEdit();
            toast("Profile updated.", "success");
        } catch (err) {
            toast(err.message, "error");
        }
    });
}

function openChangePassword() {
    const f = document.getElementById("changePasswordForm");
    if (f) f.reset();
    const m = document.getElementById("changePasswordModal");
    if (m) m.classList.add("show");
}

function closeChangePassword() {
    const m = document.getElementById("changePasswordModal");
    if (m) m.classList.remove("show");
}

const changePasswordForm = document.getElementById("changePasswordForm");
if (changePasswordForm) {
    changePasswordForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        const current_password = document.getElementById("currentPassword").value;
        const new_password = document.getElementById("newPassword").value;
        const confirm_password = document.getElementById("confirmNewPassword").value;

        if (new_password.length < 6) {
            toast("New password must be at least 6 characters.", "error");
            return;
        }
        if (new_password !== confirm_password) {
            toast("New password and confirmation do not match.", "error");
            return;
        }

        const btn = changePasswordForm.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
            await api("auth.php?action=change_password", {
                method: "POST",
                body: { current_password, new_password, confirm_password }
            });
            closeChangePassword();
            toast("Password updated successfully!", "success");
        } catch (err) {
            toast(err.message, "error");
        } finally {
            btn.disabled = false;
        }
    });
}

/* =====================================================================
   LIVE REFRESH (polling) + STARTUP
   ===================================================================== */
let polling = false;
async function pollTick() {
    if (polling) return;
    polling = true;
    try {
        if (isGuest()) {
            const [mine, roster] = await Promise.all([
                api("incidents.php?action=list&scope=mine"),
                api("roster.php?action=list")
            ]);
            state.mine = mine.incidents;
            state.roster = roster.roster;
            state.active = [];
            state.recent = [];
            state.announcements = [];

            renderDispatchAlerts();
            renderEmergencyDispatchesSection();
            renderMyRequests();
            renderCPRRoster();
            updateNotificationBell();
            return;
        }

        const calls = [
            api("incidents.php?action=list&scope=recent"),
            api("incidents.php?action=list&scope=mine"),
            api("incidents.php?action=stats"),
            api("roster.php?action=list"),
            api("announcements.php?action=list")
        ];
        if (isResponder()) calls.push(api("incidents.php?action=list&scope=active"));

        const [recent, mine, stats, roster, ann, active] = await Promise.all(calls);
        state.recent = recent.incidents;
        state.mine = mine.incidents;
        state.stats = stats.stats;
        state.roster = roster.roster;
        state.announcements = ann.announcements;
        state.active = active ? active.incidents : [];

        notifyNewIncidents(state.active);
        syncAlarmLoop();
        firstPollDone = true;

        renderDispatchAlerts();
        renderEmergencyDispatchesSection();
        renderMyRequests();
        renderDashboardStats();
        renderCPRRoster();
        renderAnnouncements();
        updateNotificationBell();
    } catch (err) {
        if (!err.network && err.status !== 401) console.error(err);
    } finally {
        polling = false;
    }
}

function lockDashboardHistory() {
    history.pushState({ lifelineDash: true }, "", window.location.href);
    window.addEventListener("popstate", () => {
        if (state.user) {
            history.pushState({ lifelineDash: true }, "", window.location.href);
        }
    });
}

async function startDashboard() {
    if (localStorage.getItem(LS.sidebar) === "true") {
        const sidebar = document.getElementById("appSidebar");
        if (sidebar) sidebar.classList.add("collapsed");
    }

    try {
        const me = await api("auth.php?action=me");
        state.user = me && me.user ? me.user : null;
    } catch (err) {
        state.user = null;
    }

    if (!state.user) {
        localStorage.removeItem(LS.loggedIn);
    } else {
        localStorage.setItem(LS.loggedIn, "1");
        lockDashboardHistory();
    }

    applyGuestAccessLocks();

    if (!isGuest()) {
        renderProfile();
        renderRoleDashboard();
        const todayStr = new Date().toISOString().split("T")[0];
        ["trnDate", "panelTrnDate"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.min = todayStr;
        });
    }

    try {
        state.meta = await api("meta.php");
    } catch (err) {
        toast("Could not load campus data: " + err.message, "error", 8000);
    }

    fillSelect(document.getElementById("building"), state.meta.buildings, "Select Building");
    updateConditionDropdownByPriority();
    if (isOfficer()) {
        fillSelect(document.getElementById("newMemberTeam"), state.meta.squads);
        fillSelect(document.getElementById("newMemberZone"), state.meta.zones);
        renderSquadOverview();
    }
    updateRoomDropdown();

    await pollTick();
    if (!isGuest()) {
        await loadTraining();
    }
    updateAlertsButton();

    const hashSection = window.location.hash.replace("#", "");
    const initialSection = isGuest()
        ? "emergency"
        : (hashSection || localStorage.getItem(LS.section) || "dashboard");
    showSection(initialSection, true);
    setInterval(pollTick, POLL_MS);
}

async function startLoginPage() {
    if (localStorage.getItem(LS.loggedIn) === "1") {
        window.location.replace("dashboard.html");
        return;
    }
    try {
        const me = await api("auth.php?action=me");
        if (me && me.user) {
            localStorage.setItem(LS.loggedIn, "1");
            window.location.replace("dashboard.html");
            return;
        }
    } catch (e) { /* stay on login page */ }
    document.body.style.visibility = "visible";
}

function initApp() {
    ["studentId", "regStudentId", "newMemberId"].forEach(id => {
        formatStudentIdInput(document.getElementById(id));
    });
    if (document.getElementById("dashboard")) startDashboard();
    else startLoginPage();
}

window.addEventListener("pageshow", (event) => {
    if (event.persisted && !document.getElementById("dashboard")) {
        startLoginPage();
    }
});

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
} else {
    initApp();
}