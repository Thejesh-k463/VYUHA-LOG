/**
 * Vyuha — pre-purchase referral form builder.
 *
 * PURPOSE: a small form every buyer fills BEFORE the purchase conversation, so
 * each sale is attributable to the influencer/collaborator who sent them —
 * the running per-referrer totals are what settle creator payouts and show
 * which collaborations actually convert. Deliberately SHORT (under a minute):
 * a long form before payment loses buyers.
 *
 * HOW TO RUN (one time, ~2 minutes — same drill as client-feedback-form.gs):
 *   1. Open https://script.google.com -> "New project".
 *   2. Delete the stub, paste this whole file, Ctrl+S.
 *   3. Set OWNER_EMAIL below if alerts should go elsewhere.
 *   4. Run > createVyuhaReferralForm -> approve the permission prompt.
 *   5. View > Logs: it prints the EDIT url, the SHARE url and the RESPONSES SHEET url.
 *      An on-submit trigger emails OWNER_EMAIL each lead WITH the referrer named
 *      in the subject, plus running per-referrer totals.
 *   6. Give each influencer their OWN link: SHARE_URL + "?usp=pp_url&entry=<code>"
 *      is fragile across form rebuilds — simpler and robust: tell each creator
 *      their code (e.g. "RAVI"), and their audience types it in the code box.
 *   7. Any time later: Run > vyuhaReferralSummary -> View > Logs prints leads
 *      per referrer and per plan (same numbers live in the linked Sheet).
 * Re-running createVyuhaReferralForm creates a SECOND form + trigger — delete
 * the first in Drive if you iterate. Script properties remember the form id.
 */
var OWNER_EMAIL = "ktr.thejesh463@gmail.com"; // <- change if alerts should go elsewhere
var REFERRER_TITLE = "Referral code / who sent you?"; // must match the question title below
var PLAN_TITLE = "Which plan are you considering?";   // must match the question title below

function createVyuhaReferralForm() {
  var form = FormApp.create("Vyuha - before you buy");
  form.setDescription(
    "Under a minute. This is how we know who to thank for sending you, and where to send " +
    "your licence key and invoice. We never ask for payment details, API keys, PAN or account " +
    "numbers here. After you submit, message us on WhatsApp +91 73936 73714 to complete the purchase."
  );
  form.setCollectEmail(false); // asked explicitly, so the sheet column is labelled
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(false);
  form.setConfirmationMessage(
    "Thank you! Now message us on WhatsApp +91 73936 73714 (or ktr.thejesh463@gmail.com) to complete the purchase - " +
    "your key and invoice arrive the same day payment is verified."
  );
  form.setShowLinkToRespondAgain(false);

  form.addTextItem().setTitle("Name").setRequired(true);
  form.addTextItem().setTitle("Email (your licence key and invoice go here)").setRequired(true)
      .setValidation(FormApp.createTextValidation().requireTextIsEmail().build());
  form.addTextItem().setTitle("WhatsApp number").setRequired(true)
      .setHelpText("Delivery and support happen on WhatsApp.");
  form.addMultipleChoiceItem().setTitle("How did you find Vyuha?").setRequired(true)
      .setChoiceValues(["A creator / influencer (name them below)", "A friend or fellow trader",
                        "X / Twitter", "YouTube", "WhatsApp / Telegram group", "GitHub / search"])
      .showOtherOption(true);
  form.addTextItem().setTitle(REFERRER_TITLE).setRequired(true)
      .setHelpText("The creator's name or the code they gave you. Type NONE if nobody sent you - honest answers keep creator payouts fair.");
  form.addMultipleChoiceItem().setTitle(PLAN_TITLE).setRequired(true)
      .setChoiceValues(["Pro - Annual (Rs 9,999)", "Journal - Lifetime", "Not decided yet"]);
  form.addCheckboxItem().setTitle("Brokers you trade with (optional)")
      .setChoiceValues(["Zerodha", "Dhan", "Groww", "Angel One", "Upstox", "Paytm Money", "Kotak Neo", "Sahi"])
      .showOtherOption(true);

  // Link a response sheet so totals are always visible without the script.
  var ss = SpreadsheetApp.create("Vyuha referrals - responses");
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // Remember ids + install the per-submission alert.
  PropertiesService.getScriptProperties().setProperty("VYUHA_REFERRAL_FORM_ID", form.getId());
  ScriptApp.newTrigger("vyuhaReferralOnSubmit").forForm(form).onFormSubmit().create();

  Logger.log("EDIT  url: " + form.getEditUrl());
  Logger.log("SHARE url: " + form.getPublishedUrl());
  Logger.log("SHEET url: " + ss.getUrl());
}

function vyuhaReferralOnSubmit(e) {
  var byTitle = {};
  e.response.getItemResponses().forEach(function (ir) {
    byTitle[ir.getItem().getTitle()] = String(ir.getResponse());
  });
  var referrer = byTitle[REFERRER_TITLE] || "?";
  var lines = Object.keys(byTitle).map(function (t) { return t + ": " + byTitle[t]; });
  var totals = vyuhaReferralTotals_();
  MailApp.sendEmail(
    OWNER_EMAIL,
    "Vyuha lead via " + referrer,
    lines.join("\n") + "\n\n-- running totals --\n" + totals
  );
}

/** Run manually: View > Logs prints leads per referrer and per plan. */
function vyuhaReferralSummary() {
  Logger.log(vyuhaReferralTotals_());
}

function vyuhaReferralTotals_() {
  var id = PropertiesService.getScriptProperties().getProperty("VYUHA_REFERRAL_FORM_ID");
  if (!id) return "(form id not recorded - run createVyuhaReferralForm first)";
  var form = FormApp.openById(id);
  var perReferrer = {}, perPlan = {}, total = 0;
  form.getResponses().forEach(function (r) {
    total++;
    r.getItemResponses().forEach(function (ir) {
      var t = ir.getItem().getTitle(), v = String(ir.getResponse()).trim();
      if (t === REFERRER_TITLE) {
        var k = v.toUpperCase() || "?";
        perReferrer[k] = (perReferrer[k] || 0) + 1;
      }
      if (t === PLAN_TITLE) perPlan[v] = (perPlan[v] || 0) + 1;
    });
  });
  var fmt = function (o) {
    return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; })
      .map(function (k) { return "  " + k + ": " + o[k]; }).join("\n") || "  (none yet)";
  };
  return total + " lead(s)\nBy referrer:\n" + fmt(perReferrer) + "\nBy plan:\n" + fmt(perPlan);
}
