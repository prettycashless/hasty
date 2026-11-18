export function createTodoTools() {
  return [
    {
      name: 'todo_write',
      permission: 'read',
      description:
        'Create or replace the task plan shown to the user. Use for multi-step work. '
        + 'Keep exactly one item in_progress while working, and mark items completed only when actually done.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'The full task list, in order.',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Short description of the step.' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Current state of the step.',
                },
              },
              required: ['content', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        if (!Array.isArray(args.items)) {
          return { content: 'items must be an array.', isError: true };
        }
        const items = args.items
          .slice(0, 40)
          .map((item) => ({
            content: String(item?.content || '').slice(0, 300),
            status: ['pending', 'in_progress', 'completed'].includes(item?.status)
              ? item.status
              : 'pending',
          }))
          .filter((item) => item.content);
        if (items.length === 0) {
          return { content: 'items must contain at least one task.', isError: true };
        }
        const inProgress = items.filter((item) => item.status === 'in_progress').length;
        if (inProgress > 1) {
          return {
            content: `Only one task can be in_progress at a time (got ${inProgress}). Update the plan and retry.`,
            isError: true,
          };
        }
        ctx.session.todos = items;
        const summary = items.map((item) => {
          const mark = item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '>' : ' ';
          return `[${mark}] ${item.content}`;
        }).join('\n');
        return {
          content: `Plan updated:\n${summary}`,
          display: { todos: items, summary: `${items.filter((i) => i.status === 'completed').length}/${items.length} done` },
        };
      },
    },
    {
      name: 'ask_user',
      permission: 'read',
      description:
        'Ask the user a question when a decision is genuinely ambiguous and cannot be resolved with tools. '
        + 'Do not use this for permission (approvals handle that) or for facts you can discover yourself.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask.' },
          options: {
            type: 'array',
            description: 'Optional short choices. The user can still type a free-form answer.',
            items: { type: 'string' },
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const question = String(args.question || '').trim();
        if (!question) return { content: 'question is required.', isError: true };
        const options = Array.isArray(args.options)
          ? args.options.map(String).slice(0, 8)
          : [];
        if (!ctx.askUser) {
          return {
            content: 'The user is not available for questions in this mode. Make a reasonable assumption, state it, and continue.',
          };
        }
        const answer = await ctx.askUser(question, options);
        return {
          content: answer == null
            ? 'The user did not answer (cancelled or EOF). Proceed with a reasonable assumption and state it.'
            : `User answered: ${answer}`,
        };
      },
    },
  ];
}
