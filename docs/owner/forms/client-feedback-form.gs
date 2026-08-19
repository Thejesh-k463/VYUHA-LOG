/**
 * Vyuha — client feedback Google Form builder.
 * Source of truth: docs/owner/CLIENT_FEEDBACK_FORM.md (owner-edited 2026-08-19).
 *
 * HOW TO RUN (one time, ~2 minutes):
 *   1. Open https://script.google.com -> "New project".
 *   2. Delete the stub, paste this whole file, Ctrl+S.
 *   3. Set OWNER_EMAIL below to the address that should receive submission alerts.
 *   4. Run > createVyuhaFeedbackForm -> approve the Forms/Drive/Gmail/Sheets permission prompt (your own account).
 *   5. View > Logs: it prints the EDIT url, the SHARE url and the RESPONSES SHEET url.
 *      The script also installs an on-submit trigger, so EVERY submission emails OWNER_EMAIL a summary
 *      plus the running totals (responses / Pro annual / Lifetime).
 *   6. Share the SHARE url (the /viewform one) on WhatsApp after purchase.
 *   7. Any time later: Run > vyuhaSummary -> View > Logs prints total responses and the plan split
 *      (and the same numbers are always visible in the linked Sheet / the form's Responses tab).
 * Re-running createVyuhaFeedbackForm creates a SECOND form + trigger - delete the first in Drive if you iterate.
 * Script properties remember the form id so vyuhaSummary/onSubmit know which form to read.
 */
var OWNER_EMAIL = "thejesh463.git@gmail.com"; // <- change if alerts should go elsewhere
var PLAN_TITLE = "Your plan";                     // must match the question title below

function createVyuhaFeedbackForm() {
  var form = FormApp.create("Vyuha - tell us how it is going");
  form.setDescription(
    "About 5 minutes. This helps us support you, fix what matters, and decide what to build next. " +
    "We never ask for API keys, TOTP secrets, PAN or account numbers - please do not paste them anywhere here. " +
    "Reply lands on WhatsApp within a day. Nothing you type is shared."
  );
  form.setCollectEmail(false);          // ask explicitly instead (Q2)
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(true);
  form.setConfirmationMessage("Thank you - reply lands on WhatsApp within a day. Nothing you typed is shared.");
  form.setShowLinkToRespondAgain(false);

  var WA = "If anything here goes wrong in the next days or weeks of use, message us on WhatsApp +91 73936 73714 - we check and fix.";

  // -- Section 1 - About you (required)
  form.addSectionHeaderItem().setTitle("1 - About you").setHelpText("Only this block is required.");
  form.addTextItem().setTitle("Name").setRequired(true);
  form.addTextItem().setTitle("Email").setRequired(true)
      .setValidation(FormApp.createTextValidation().requireTextIsEmail().build());
  form.addTextItem().setTitle("WhatsApp number (optional)");
  form.addTextItem().setTitle("City").setRequired(true);
  form.addMultipleChoiceItem().setTitle("Which best describes you?").setRequired(true)
      .setChoiceValues(["Intraday", "Swing / positional", "Options seller", "Options buyer",
                        "Long-term investor with some trading", "Full-time trader", "Part-time"]);
  form.addCheckboxItem().setTitle("Brokers you actively use").setRequired(true)
      .setChoiceValues(["Zerodha", "Dhan", "Groww", "Angel One", "Upstox", "Paytm Money", "Kotak Neo", "Sahi", "ICICI Direct", "HDFC Sky"])
      .showOtherOption(true);
  form.addMultipleChoiceItem().setTitle("Approximate trades per month").setRequired(true)
      .setChoiceValues(["Under 20", "20-100", "100-500", "500+"]);
  form.addCheckboxItem().setTitle("Segments you trade").setRequired(true)
      .setChoiceValues(["Equity delivery", "Intraday", "Equity MTF", "Index options", "Stock options", "Futures", "MCX commodities", "Currency"]);

  // -- Section 2 - How you found and use Vyuha
  form.addPageBreakItem().setTitle("2 - How you found and use Vyuha");
  form.addMultipleChoiceItem().setTitle("How did you hear about Vyuha?")
      .setChoiceValues(["WhatsApp", "A creator (tell us who below)", "X / Twitter", "GitHub", "A friend", "Search"])
      .showOtherOption(true);
  form.addTextItem().setTitle("If a creator - who?");
  form.addTextItem().setTitle("Vyuha version you are on")
      .setHelpText("Settings > License, or the sidebar footer (e.g. v2.99.97).");
  form.addMultipleChoiceItem().setTitle("Your plan").setChoiceValues(["Pro - Annual", "Journal - Lifetime"]);
  form.addCheckboxItem().setTitle("How did you get your trades in?")
      .setHelpText(WA)
      .setChoiceValues(["Zerodha file", "Dhan file", "Groww file", "Angel One file", "Upstox file", "Paytm Money file",
                        "Column mapper (tell us which broker in the next box)", "Kite API", "Dhan API", "Angel One API", "Typed by hand"]);
  form.addTextItem().setTitle("If column mapper - which broker?");
  form.addMultipleChoiceItem().setTitle("Did the import work first time?")
      .setHelpText(WA)
      .setChoiceValues(["Yes", "Needed the column mapper", "Wrong numbers", "Failed"]);
  form.addParagraphTextItem().setTitle("If not - what happened?")
      .setHelpText("Describe it; if you have a screenshot, send a REDACTED one on WhatsApp - never the broker file itself.");
  form.addMultipleChoiceItem().setTitle("Do the charges Vyuha computed match your contract note?")
      .setHelpText(WA)
      .setChoiceValues(["Yes, within a rupee", "Off by a small amount", "Off by a lot", "Didn't check"]);

  // -- Section 3 - What matters
  form.addPageBreakItem().setTitle("3 - What matters").setHelpText("This ranking sets the roadmap.");
  form.addCheckboxItem().setTitle("The five things you use most (pick up to 5)")
      .setChoiceValues(["Dashboard / KPIs", "Trades table", "Staged positions", "Options Seller Journal", "Portfolio risk",
                        "Tax pack (ITR / AIS / advance tax)", "Arjun's Eye / Discipline", "Lenses / Edge", "Playbooks",
                        "Trade calculator", "Charges & MTF comparison", "Backup / restore", "Appearance (skins, tint, custom theme, wallpaper)"])
      .setValidation(FormApp.createCheckboxValidation().requireSelectAtMost(5).build());
  form.addParagraphTextItem().setTitle("What is missing that would make you open Vyuha every day? (optional)");
  form.addTextItem().setTitle("Which broker would you most like connected next - and how: file, API, or manual entry is fine?");
  form.addMultipleChoiceItem().setTitle("Would a Mac or web version matter to you?")
      .setChoiceValues(["No", "Nice to have", "I can't use it without"]);

  // -- Section 4 - Trust
  form.addPageBreakItem().setTitle("4 - Trust");
  form.addMultipleChoiceItem().setTitle("Which matters more to you?")
      .setChoiceValues(["My data stays on my own machine", "Access from any device"]);
  form.addScaleItem().setTitle("How likely are you to recommend Vyuha to a trading friend?")
      .setBounds(0, 10).setLabels("Not at all", "Definitely");

  // -- Section 5 - Consent and follow-up
  form.addPageBreakItem().setTitle("5 - Consent and follow-up");
  form.addMultipleChoiceItem().setTitle("May we quote your feedback on the landing page?")
      .setChoiceValues(["Yes, with first name + city", "Yes, anonymously", "No"]);
  form.addMultipleChoiceItem().setTitle("Happy to do a 10-minute call?").setChoiceValues(["Yes", "No"]);
  form.addTextItem().setTitle("If yes - best day/time");
  form.addParagraphTextItem().setTitle("Anything else - bugs, praise, rants.");

  // Responses -> a Google Sheet (auto-created next to the form), so counts are always one tab away.
  var sheet = SpreadsheetApp.create("Vyuha feedback - responses");
  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());

  // Remember the form, then install the on-submit alert trigger.
  PropertiesService.getScriptProperties().setProperty("VYUHA_FORM_ID", form.getId());
  ScriptApp.newTrigger("onVyuhaSubmit").forForm(form).onFormSubmit().create();

  Logger.log("EDIT   : " + form.getEditUrl());
  Logger.log("SHARE  : " + form.getPublishedUrl());
  Logger.log("SHEET  : " + sheet.getUrl());
  Logger.log("Alerts : every submission emails " + OWNER_EMAIL);
  return form.getPublishedUrl();
}

/** Fires on every submission (installed by createVyuhaFeedbackForm). Emails a digest + running totals. */
function onVyuhaSubmit(e) {
  var form = FormApp.openById(PropertiesService.getScriptProperties().getProperty("VYUHA_FORM_ID"));
  var items = e.response.getItemResponses();
  var lines = [];
  var name = "", plan = "", city = "", nps = "";
  for (var i = 0; i < items.length; i++) {
    var t = items[i].getItem().getTitle(), v = items[i].getResponse();
    if (v === "" || v === null || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(t + ": " + (Array.isArray(v) ? v.join(", ") : v));
    if (t === "Name") name = v;
    if (t === PLAN_TITLE) plan = v;
    if (t === "City") city = v;
    if (t.indexOf("recommend Vyuha") >= 0) nps = v;
  }
  var tot = vyuhaTotals_(form);
  var subject = "[Vyuha feedback] " + (name || "someone") + (city ? " · " + city : "") +
                (plan ? " · " + plan : "") + (nps !== "" ? " · NPS " + nps : "") +
                " — total " + tot.total + " (Pro " + tot.annual + " / Lifetime " + tot.lifetime + ")";
  var NL = String.fromCharCode(10);
  var body = "New response at " + new Date().toLocaleString("en-IN") + NL + NL + lines.join(NL) +
             NL + NL + "--- Running totals ---" + NL + "Responses: " + tot.total +
             NL + "Pro - Annual: " + tot.annual + NL + "Journal - Lifetime: " + tot.lifetime +
             NL + "No plan stated: " + tot.unknown +
             NL + NL + "Sheet: https://docs.google.com/spreadsheets/d/" + form.getDestinationId() +
             NL + "Edit form: " + form.getEditUrl();
  MailApp.sendEmail(OWNER_EMAIL, subject, body);
}

/** Run by hand any time: prints total responses and the plan split to the Logs. */
function vyuhaSummary() {
  var id = PropertiesService.getScriptProperties().getProperty("VYUHA_FORM_ID");
  if (!id) { Logger.log("Run createVyuhaFeedbackForm first."); return; }
  var tot = vyuhaTotals_(FormApp.openById(id));
  Logger.log("Responses: " + tot.total + " | Pro - Annual: " + tot.annual +
             " | Journal - Lifetime: " + tot.lifetime + " | no plan stated: " + tot.unknown);
  return tot;
}

function vyuhaTotals_(form) {
  var rs = form.getResponses(), annual = 0, lifetime = 0, unknown = 0;
  for (var i = 0; i < rs.length; i++) {
    var plan = "";
    var items = rs[i].getItemResponses();
    for (var j = 0; j < items.length; j++) if (items[j].getItem().getTitle() === PLAN_TITLE) plan = items[j].getResponse();
    if (plan === "Pro - Annual") annual++; else if (plan === "Journal - Lifetime") lifetime++; else unknown++;
  }
  return { total: rs.length, annual: annual, lifetime: lifetime, unknown: unknown };
}
