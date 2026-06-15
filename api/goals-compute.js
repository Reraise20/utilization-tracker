// ============================================================================
// api/goals-compute.js
// ----------------------------------------------------------------------------
// Returns a fully scored goal snapshot for one employee for one (year, month).
// Run-rate projection applied if month is in progress.
//
// Usage:
//   GET /api/goals-compute?employee_id=12&year=2026&month=6
//
// No npm dependencies. Uses raw fetch() against Supabase REST API, matching
// the pattern in api/aranalyze.js. No package.json required.
// ============================================================================

// ── Supabase config (anon key — same as client-side, fine for this scope) ──
const SB_URL = "https://hjmbsakopcnbnqppvzdo.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqbWJzYWtvcGNuYm5xcHB2emRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4Mjg5MTMsImV4cCI6MjA4OTQwNDkxM30.ZKYB5gMu9zqo4tXz4iPdjmJADhoqVvBt2uG8JAcOCmI";

// ── EDITABLE: task type mapping for utilization calc ────────────────────────
const TASK_TYPE_CONFIG = {
  count_based: {
    'MCS':    30,
    'Audits': 30,
  },
  hours_based: ['Payer Analysis', 'Jira', 'Research'],
  daily_working_hours: 8,
};

// ── REST helper ─────────────────────────────────────────────────────────────
async function sbGet(table, params) {
  const url = SB_URL + "/rest/v1/" + table + (params ? "?" + params : "");
  const r = await fetch(url, {
    headers: { "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error("Supabase " + r.status + " on " + table + ": " + txt.slice(0, 200));
  }
  return r.json();
}


// ============================================================================
// MAIN HANDLER
// ============================================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const employee_id = parseInt(req.query.employee_id, 10);
    const year        = parseInt(req.query.year, 10);
    const month       = parseInt(req.query.month, 10);
    const isFinal     = req.query.final === 'true';

    if (!employee_id || !year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: 'Required: employee_id, year, month (1-12)' });
    }

    const monthStart  = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd    = new Date(Date.UTC(year, month, 1));
    const today       = new Date();
    const isCurrentMonth = today >= monthStart && today < monthEnd;
    const daysTotal   = new Date(year, month, 0).getDate();
    const daysElapsed = isCurrentMonth
      ? today.getUTCDate()
      : (today >= monthEnd ? daysTotal : 0);

    const monthStartISO = monthStart.toISOString().slice(0, 10);
    const monthEndISO   = monthEnd.toISOString().slice(0, 10);

    const [
      employees,
      definitions,
      ratingScale,
      configRows,
      entriesRows,
      auditTrackerRows,
      monthlyInputRows,
      dailyInputRows,
    ] = await Promise.all([
      sbGet("employees", "select=id,name&id=eq." + employee_id),
      sbGet("goal_definitions", "select=*&effective_to=is.null&order=display_order"),
      sbGet("goal_rating_scale", "select=*&order=rating"),
      sbGet("goal_config", "select=key,value"),
      sbGet("entries", "select=task_type,count,hours,date,employee&date=gte." + monthStartISO + "&date=lt." + monthEndISO),
      sbGet("audit_tracker", "select=audit_date,employee,audits_performed,rebuttal,rebuttal_accepted,duplicate_audit&audit_date=gte." + monthStartISO + "&audit_date=lt." + monthEndISO),
      sbGet("goal_monthly_inputs", "select=*&employee_id=eq." + employee_id + "&goal_year=eq." + year + "&goal_month=eq." + month),
      sbGet("goal_daily_inputs", "select=*&employee_id=eq." + employee_id + "&entry_date=gte." + monthStartISO + "&entry_date=lt." + monthEndISO),
    ]);

    if (!employees.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const employee     = employees[0];
    const config       = Object.fromEntries(configRows.map(r => [r.key, r.value]));
    const myEntries    = entriesRows.filter(e => e.employee === employee.name);
    const allAudits    = auditTrackerRows.filter(a => a.employee === employee.name);
    const monthlyInput = monthlyInputRows[0] || {};
    const dailyInputs  = dailyInputRows || [];

    const ctx = {
      employee, year, month,
      monthStart, monthEnd, daysElapsed, daysTotal, isCurrentMonth,
      config, myEntries, allAudits, monthlyInput, dailyInputs,
    };

    const metrics = definitions.map(def => computeMetric(def, ctx));

    const totals      = rollUp(metrics, ratingScale, false);
    const projection  = isCurrentMonth && !isFinal
      ? rollUp(metrics, ratingScale, true)
      : null;

    const ai_payload = buildAIPayload(employee, year, month, ctx, metrics, totals, projection);

    return res.status(200).json({
      employee:   { id: employee.id, name: employee.name },
      period:     {
        year, month,
        days_elapsed: daysElapsed,
        days_total:   daysTotal,
        is_current_month: isCurrentMonth,
      },
      metrics,
      totals,
      projection,
      ai_payload,
      generated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('goals-compute error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}


// ============================================================================
// METRIC ROUTER
// ============================================================================
function computeMetric(def, ctx) {
  const handlers = {
    utilization:           computeUtilization,
    audit_completion:      computeAuditCompletion,
    attendance:            computeAttendance,
    ata_accuracy:          computeATAAccuracy,
    pkt_accuracy:          (d, c) => simpleManual(d, c, 'pkt_score_pct'),
    mcs_past_due:          computeMCSPastDue,
    jira_tat:              computeJiraTAT,
    process_improvement:   (d, c) => simpleManual(d, c, 'ideas_submitted'),
    grade_improvement:     computeGradeImprovement,
    client_escalation_ews: computeClientEscalation,
    warning_no_show:       computeWarningNoShow,
  };
  const fn = handlers[def.metric_key];
  if (!fn) return scoredRow(def, null, 1, 'Unknown metric key', 'none');
  return fn(def, ctx);
}


// ============================================================================
// COMPUTATIONS
// ============================================================================

function computeUtilization(def, ctx) {
  const { myEntries, daysElapsed, daysTotal, isCurrentMonth } = ctx;
  const dailyHours = TASK_TYPE_CONFIG.daily_working_hours;

  let productiveHours = 0;
  const breakdownMap = {}; // task_type -> { hours, raw, kind }
  for (const e of myEntries) {
    let hrs = null;
    let raw, kind;
    if (TASK_TYPE_CONFIG.count_based[e.task_type] != null) {
      const dailyTarget  = TASK_TYPE_CONFIG.count_based[e.task_type];
      const hourlyTarget = dailyTarget / dailyHours; // units/hour target
      hrs  = (e.count || 0) / hourlyTarget;
      raw  = e.count || 0;
      kind = `count @ ${dailyTarget}/day target`;
    } else if (TASK_TYPE_CONFIG.hours_based.includes(e.task_type)) {
      hrs  = parseFloat(e.hours || 0);
      raw  = hrs;
      kind = 'logged hours';
    } else {
      continue; // task type not counted toward utilization
    }
    productiveHours += hrs;
    if (!breakdownMap[e.task_type]) breakdownMap[e.task_type] = { task_type: e.task_type, raw: 0, hours: 0, kind };
    breakdownMap[e.task_type].raw   += raw;
    breakdownMap[e.task_type].hours += hrs;
  }
  const breakdown = Object.values(breakdownMap)
    .map(b => ({ ...b, raw: round2(b.raw), hours: round2(b.hours) }))
    .sort((a, b) => b.hours - a.hours);

  const effectiveDays  = isCurrentMonth ? daysElapsed : daysTotal;
  const workingDays    = countWorkingDays(ctx.monthStart, effectiveDays);
  const expectedHours  = workingDays * dailyHours;
  const utilizationPct = expectedHours > 0 ? (productiveHours / expectedHours) * 100 : 0;

  let projectedPct = utilizationPct;
  if (isCurrentMonth && daysElapsed > 0 && workingDays > 0) {
    const fullMonthWorkingDays = countWorkingDays(ctx.monthStart, daysTotal);
    const fullMonthExpected    = fullMonthWorkingDays * dailyHours;
    const projectedProductive  = productiveHours * (fullMonthWorkingDays / workingDays);
    projectedPct = fullMonthExpected > 0 ? (projectedProductive / fullMonthExpected) * 100 : 0;
  }

  return scoredRow(def,
    round2(utilizationPct), applyRatingBand(def, utilizationPct),
    `${productiveHours.toFixed(1)} productive hrs / ${expectedHours.toFixed(1)} expected hrs (${workingDays} working days × ${dailyHours}h/day)`,
    'auto',
    {
      projected_achieved: round2(projectedPct), projected_rating: applyRatingBand(def, projectedPct),
      breakdown,
      working_days: workingDays,
      daily_working_hours: dailyHours,
    }
  );
}

function computeAuditCompletion(def, ctx) {
  const { allAudits, config } = ctx;
  const weeklyTarget = Number(config.weekly_audit_target || 63);
  const weeksRequired = Number(config.weeks_required_for_audit_pass || 4);

  const weekTotals = {};
  for (const a of allAudits) {
    const wk = getWeekKey(a.audit_date);
    weekTotals[wk] = (weekTotals[wk] || 0) + (a.audits_performed || 0);
  }
  const weeksMet = Object.values(weekTotals).filter(t => t >= weeklyTarget).length;
  const passed   = weeksMet >= weeksRequired;
  const rating   = passed ? def.rating_bands.pass.score : def.rating_bands.fail.score;

  return scoredRow(def, weeksMet, rating,
    `${weeksMet} weeks met target of ${weeklyTarget} audits/week (need ${weeksRequired})`,
    'auto'
  );
}

function computeAttendance(def, ctx) {
  const m = ctx.monthlyInput;
  if (m == null || m.working_days == null || m.leaves_taken == null) {
    return scoredRow(def, null, null, 'Awaiting working_days + leaves_taken', 'manual');
  }
  const pct = m.working_days > 0
    ? ((m.working_days - m.leaves_taken) / m.working_days) * 100
    : 0;
  return scoredRow(def, round2(pct), applyRatingBand(def, pct),
    `${m.working_days - m.leaves_taken}/${m.working_days} present`, 'manual');
}

function computeATAAccuracy(def, ctx) {
  const { allAudits, config } = ctx;
  const minRequired = Number(config.min_ata_audits_required || 10);

  const validAudits = allAudits.filter(a => !a.duplicate_audit);
  const total       = validAudits.length;
  const errors      = validAudits.filter(a => a.rebuttal_accepted === true).length;

  if (total < minRequired) {
    return scoredRow(def, null, null,
      `${total}/${minRequired} min audits required — metric not yet applicable`, 'auto',
      { audits_so_far: total, min_required: minRequired }
    );
  }

  const accuracyPct = 100 - (errors / total) * 100;
  const passed      = accuracyPct >= 95;
  const rating      = passed ? def.rating_bands.pass.score : def.rating_bands.fail.score;

  return scoredRow(def, round2(accuracyPct), rating,
    `${total - errors}/${total} accurate (${errors} accepted rebuttals)`, 'auto');
}

function computeMCSPastDue(def, ctx) {
  const vals = ctx.dailyInputs.map(d => d.mcs_past_due_pct).filter(v => v != null);
  if (!vals.length) return scoredRow(def, null, null, 'No daily entries yet', 'manual');
  const worst  = Math.max(...vals);
  const passed = worst <= 0;
  const rating = passed ? def.rating_bands.pass.score : def.rating_bands.fail.score;
  return scoredRow(def, round2(worst), rating,
    `Worst day: ${worst.toFixed(2)}% past due (over ${vals.length} daily entries)`, 'manual');
}

function computeJiraTAT(def, ctx) {
  const vals = ctx.dailyInputs.map(d => d.jira_out_of_tat_count).filter(v => v != null);
  if (!vals.length) return scoredRow(def, null, null, 'No daily entries yet', 'manual');
  const worst = Math.max(...vals);
  return scoredRow(def, worst, applyRatingBand(def, worst),
    `High-water count: ${worst} instances out of TAT`, 'manual');
}

function computeGradeImprovement(def, ctx) {
  const v = ctx.monthlyInput?.df_practices_count;
  if (v == null) return scoredRow(def, null, null, 'Awaiting df_practices_count', 'manual');
  const passed = v === 0;
  const rating = passed ? def.rating_bands.pass.score : def.rating_bands.fail.score;
  return scoredRow(def, v, rating, `${v} practices in D&F`, 'manual');
}

function computeClientEscalation(def, ctx) {
  const v = ctx.monthlyInput?.client_escalations;
  if (v == null) return scoredRow(def, null, null, 'Awaiting client_escalations', 'manual');
  const passed = v === 0;
  const rating = passed ? def.rating_bands.pass.score : def.rating_bands.fail.score;
  return scoredRow(def, v, rating, `${v} escalations`, 'manual');
}

function computeWarningNoShow(def, ctx) {
  const m = ctx.monthlyInput || {};
  const fail = (m.warning_letter === true) || (m.no_call_no_show === true);
  const rating = fail ? def.rating_bands.fail.score : def.rating_bands.pass.score;
  return scoredRow(def, fail ? 1 : 0, rating,
    fail ? 'Instance(s) recorded' : 'No instances', 'manual');
}

function simpleManual(def, ctx, fieldName) {
  const v = ctx.monthlyInput?.[fieldName];
  if (v == null) return scoredRow(def, null, null, `Awaiting ${fieldName}`, 'manual');
  return scoredRow(def, v, applyRatingBand(def, v), `${fieldName} = ${v}`, 'manual');
}


// ============================================================================
// RATING BAND APPLICATION
// ============================================================================
function applyRatingBand(def, value) {
  if (value == null) return null;
  const bands = def.rating_bands;

  if (def.rating_type === 'pass_fail') {
    return bands.pass?.score ?? 5;
  }

  for (const rating of [5, 4, 3, 2, 1]) {
    const b = bands[String(rating)];
    if (!b) continue;
    const minOk = b.min == null || value >= b.min;
    const maxOk = b.max == null || value <= b.max;
    if (minOk && maxOk) return rating;
  }
  return 1;
}


// ============================================================================
// ROLL-UP
// ============================================================================
function rollUp(metrics, ratingScale, useProjection) {
  let total = 0;
  for (const m of metrics) {
    const rating = useProjection ? (m.projected_rating ?? m.rating) : m.rating;
    if (rating == null) continue;
    total += (m.weightage_pct / 100) * rating;
  }
  const score = round2(total);
  const band  = ratingScale.find(r => score >= r.min_score && score <= r.max_score)
              || ratingScale[ratingScale.length - 1];
  return {
    score,
    rating: band?.rating ?? 1,
    rating_label: band?.label ?? 'Needs improvement',
  };
}


// ============================================================================
// AI PAYLOAD
// ============================================================================
function buildAIPayload(employee, year, month, ctx, metrics, totals, projection) {
  return {
    context: {
      employee_name: employee.name,
      period:        `${year}-${String(month).padStart(2, '0')}`,
      days_elapsed:  ctx.daysElapsed,
      days_total:    ctx.daysTotal,
      is_current_month: ctx.isCurrentMonth,
    },
    current_totals: totals,
    projected_totals: projection,
    metrics: metrics.map(m => ({
      key:           m.metric_key,
      label:         m.metric_label,
      category:      m.category,
      weightage_pct: m.weightage_pct,
      achieved:      m.achieved,
      rating:        m.rating,
      weighted_score: m.weighted_score,
      projected_achieved: m.projected_achieved ?? null,
      projected_rating:   m.projected_rating ?? null,
      explanation:   m.explanation,
      source:        m.source,
      is_reverse:    m.is_reverse,
    })),
    gaps: metrics
      .filter(m => m.rating != null && m.rating < 5 && !m.is_reverse)
      .map(m => ({
        metric: m.metric_label,
        current_rating: m.rating,
        score_lift_if_next_tier: round2((m.weightage_pct / 100) * 1),
      }))
      .sort((a, b) => b.score_lift_if_next_tier - a.score_lift_if_next_tier),
  };
}


// ============================================================================
// HELPERS
// ============================================================================
function scoredRow(def, achieved, rating, explanation, source, extras = {}) {
  const weightedScore = rating != null ? round2((def.weightage_pct / 100) * rating) : null;
  return {
    metric_key:     def.metric_key,
    metric_label:   def.metric_label,
    category:       def.category,
    weightage_pct:  def.weightage_pct,
    is_reverse:     def.is_reverse,
    rating_type:    def.rating_type,
    achieved,
    rating,
    weighted_score: weightedScore,
    explanation,
    source,
    ...extras,
  };
}

function round2(n) {
  if (n == null || isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

function getWeekKey(dateStr) {
  const d = new Date(dateStr);
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function countWorkingDays(monthStart, daysCount) {
  let count = 0;
  for (let i = 0; i < daysCount; i++) {
    const d = new Date(monthStart);
    d.setUTCDate(d.getUTCDate() + i);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) count++;
  }
  return count;
}
