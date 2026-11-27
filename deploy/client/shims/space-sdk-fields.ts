// Reemplazo de "@hatch/space-sdk/fields" para la versión independiente.
// Devuelve los mismos límites que declaran las acciones del tablero en
// server/src/actions.ts (longitudes máximas, mínimos y máximos), para
// que los formularios se comporten igual que dentro de Muse.

const text = (maxLength: number, required = false) => ({
  maxLength,
  ...(required ? { required: true } : {}),
});
const num = (min: number, max: number) => ({ type: "number", min, max });

const sessionFields = {
  client_name: text(120, true),
  package_label: text(40),
  photo_count: num(0, 10000),
  drive_url: text(500),
  favorites_count: num(0, 10000),
  face_level: text(120),
  body_adjustments: text(300),
  motive: text(200),
  do_not_touch: text(300),
  background_color: text(60),
  discovery_source: text(80),
  notes: text(1000),
};

export function actionFields() {
  return {
    createSession: sessionFields,
    updateSession: sessionFields,
    saveMonthlyClose: {
      estimate_sales: num(0, 100000000),
      projected_sales: num(0, 100000000),
      actual_sales: num(0, 100000000),
      actual_fixed_costs: num(0, 100000000),
      actual_variable_costs: num(0, 100000000),
      notes: text(1000),
    },
    addExpense: {
      description: text(200, true),
      amount: num(1, 10000000),
    },
  };
}
