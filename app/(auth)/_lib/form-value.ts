import { z } from "zod";

const formValueSchema = z.string().catch("");

export function formValue(form: HTMLFormElement, name: string) {
  return formValueSchema.parse(new FormData(form).get(name));
}
