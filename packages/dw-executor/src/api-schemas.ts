import { type TSchema, Type } from "typebox";
import { ErrorSchema } from "./protocol.ts";

export const ResourceIdSchema = Type.String({
	minLength: 1,
	maxLength: 300,
	pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,299}$",
});
export const RevisionSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const RFC3339TimestampSchema = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
});
export const ExpectedRevisionSchema = Type.Object(
	{ expected_revision: RevisionSchema },
	{ additionalProperties: false },
);
export const PaginationQuerySchema = Type.Object(
	{
		cursor: Type.Optional(
			Type.String({ minLength: 1, maxLength: 8192, pattern: "^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)?$" }),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
	},
	{ additionalProperties: false },
);
export const HttpErrorSchema = Type.Object(
	{ error: ErrorSchema, request_id: ResourceIdSchema },
	{ additionalProperties: false },
);

/** Standard durable HTTP resource envelope; the supplied schema describes data, not the envelope. */
export function StoredSchema<T extends TSchema>(data: T) {
	return Type.Object(
		{
			id: ResourceIdSchema,
			revision: RevisionSchema,
			created_at: RFC3339TimestampSchema,
			updated_at: RFC3339TimestampSchema,
			data,
		},
		{ additionalProperties: false },
	);
}

/** Cursor pages contain complete resource items and never expose store offsets. */
export function PageSchema<T extends TSchema>(item: T) {
	return Type.Object(
		{ items: Type.Array(item), next_cursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]) },
		{ additionalProperties: false },
	);
}
