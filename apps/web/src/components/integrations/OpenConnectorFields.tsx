import type { ConnectorCredentialField } from "@rakazo/contracts";
import { Input, Textarea } from "@rakazo/ui-web";
import { useId } from "react";

export function OpenConnectorFields({
  fields,
  values,
  onChange,
  disabled,
}: {
  fields: ConnectorCredentialField[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <>
      {fields.map((field) => (
        <div key={field.key} className="space-y-1.5">
          <label htmlFor={`${id}-${field.key}`} className="text-sm font-medium">
            {field.label}
          </label>
          {(field.inputType === "textarea" || field.inputType === "json") && !field.secret ? (
            <Textarea
              id={`${id}-${field.key}`}
              value={values[field.key] ?? ""}
              required={field.required}
              disabled={disabled}
              placeholder={field.placeholder}
              onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
            />
          ) : (
            <Input
              id={`${id}-${field.key}`}
              type={field.secret || field.inputType === "password" ? "password" : "text"}
              autoComplete={field.secret ? "new-password" : "off"}
              value={values[field.key] ?? ""}
              required={field.required}
              disabled={disabled}
              placeholder={field.placeholder}
              onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
            />
          )}
        </div>
      ))}
    </>
  );
}
