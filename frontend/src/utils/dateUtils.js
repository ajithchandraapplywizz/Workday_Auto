// Utility function to strictly return previous workday T-1
// If reference is Friday (day 5), previous is Thursday.
// If reference is Saturday (day 6), previous is Friday.
// If reference is Sunday (day 0), previous is Friday.
// If reference is Monday (day 1), previous is Friday.
export const getPreviousWorkdayDateStr = (refDate = new Date()) => {
  const d = new Date(refDate);
  const day = d.getDay(); // 0 is Sunday, 6 is Saturday

  let daysToSubtract = 1;
  if (day === 0) {
    // Sunday -> Friday
    daysToSubtract = 2;
  } else if (day === 1) {
    // Monday -> Friday
    daysToSubtract = 3;
  } else if (day === 6) {
    // Saturday -> Friday
    daysToSubtract = 1;
  } else {
    // Tue, Wed, Thu, Fri -> yesterday
    daysToSubtract = 1;
  }

  d.setDate(d.getDate() - daysToSubtract);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

export const getYesterdayDateStr = () => getPreviousWorkdayDateStr();
