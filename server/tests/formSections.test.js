const test = require('node:test');
const assert = require('node:assert/strict');
const { AppError } = require('../middleware/errorsMiddleware');
const { resolveFormSections } = require('../utils/formDefinition');
const { validateSubmissionAnswers } = require('../utils/submissionValidation');
const { getNextSectionIndex } = require('../utils/sectionFlow');
const { assertIdentityOnEveryPath } = require('../utils/fieldIdentity');
const Form = require('../models/FormModel');
const mongoose = require('mongoose');

const requiredIdentity = [
  { label: 'Full Name', type: 'TextInput', required: true },
  { label: 'Email', type: 'TextInput', required: true }
];

test('flat fields remain compatible and receive a registration section', () => {
  const sections = resolveFormSections({
    fields: requiredIdentity
  }, AppError);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 'registration');
  assert.deepEqual(
      sections[0].fields.map(field => field.id),
      ['full_name', 'email']
  );
});

test('Dropdown and Checkbox routes navigate to their configured sections', () => {
  const sections = resolveFormSections({
    sections: [
      {
        id: 'first',
        title: 'First',
        fields: [
          ...requiredIdentity,
          {
            label: 'Path',
            type: 'Dropdown',
            required: true,
            options: ['Continue', 'Jump'],
            routes: [{ option: 'Jump', goToSection: 'last' }]
          },
        ]
      },
      {
        id: 'middle',
        title: 'Middle',
        fields: [{ label: 'Middle answer', type: 'TextInput', required: true }]
      },
      {
        id: 'last',
        title: 'Last',
        fields: [{ label: 'Last answer', type: 'TextInput', required: true }]
      }
    ]
  }, AppError);

  assert.equal(
      getNextSectionIndex(sections, 0, { path: 'Jump' }),
      2
  );
  const checkboxSections = resolveFormSections({
    sections: [
      {
        id: 'first',
        title: 'First',
        fields: [{
          label: 'Topics',
          type: 'Checkbox',
          required: false,
          options: ['A', 'B'],
          routes: [{ option: 'B', goToSection: 'last' }]
        }]
      },
      {
        id: 'middle',
        title: 'Middle',
        fields: [{ label: 'Middle answer', type: 'TextInput' }]
      },
      {
        id: 'last',
        title: 'Last',
        fields: [{ label: 'Last answer', type: 'TextInput' }]
      }
    ]
  }, AppError);
  assert.equal(
      getNextSectionIndex(checkboxSections, 0, { topics: ['A', 'B'] }),
      2
  );
  assert.throws(() => resolveFormSections({
    sections: [
      {
        id: 'first',
        title: 'First',
        fields: [{
          label: 'Path',
          type: 'Dropdown',
          options: ['Jump'],
          routes: [{ option: 'Jump', goToSection: 'missing' }]
        }]
      }
    ]
  }, AppError), /does not exist/);
});

test('submission validates only visited sections and discards skipped answers', () => {
  const sections = [
    {
      id: 'start',
      title: 'Start',
      fields: [
        { id: 'full_name', label: 'Full Name', type: 'TextInput', required: true },
        { id: 'email', label: 'Email', type: 'TextInput', required: true },
        {
          id: 'route',
          label: 'Route',
          type: 'Dropdown',
          required: true,
          options: ['Stay', 'Jump'],
          routes: [{ option: 'Jump', goToSection: 'end' }]
        }
      ]
    },
    {
      id: 'middle',
      title: 'Middle',
      fields: [{ id: 'required_middle', label: 'Required middle', type: 'TextInput', required: true }]
    },
    {
      id: 'end',
      title: 'End',
      fields: [{ id: 'end_answer', label: 'End answer', type: 'TextInput', required: true }]
    }
  ];

  const result = validateSubmissionAnswers({
    sections
  }, {
    full_name: ' Ada Lovelace ',
    email: 'ADA@example.com',
    route: 'Jump',
    required_middle: 'must be discarded',
    end_answer: 'visited'
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.visitedSectionIds, ['start', 'end']);
  assert.deepEqual(result.answers, {
    full_name: 'Ada Lovelace',
    email: 'ada@example.com',
    route: 'Jump',
    end_answer: 'visited'
  });
});

test('identity fields cannot be bypassed by a conditional route', () => {
  const sections = [
    {
      id: 'start',
      title: 'Start',
      fields: [{
        id: 'route',
        label: 'Route',
        type: 'Dropdown',
        options: ['Identity', 'Skip'],
        routes: [{ option: 'Skip', goToSection: 'end' }]
      }]
    },
    {
      id: 'identity',
      title: 'Identity',
      fields: requiredIdentity.map(field => ({
        ...field,
        id: field.label === 'Full Name' ? 'full_name' : 'email'
      }))
    },
    {
      id: 'end',
      title: 'End',
      fields: [{ id: 'answer', label: 'Answer', type: 'TextInput' }]
    }
  ];

  assert.throws(
      () => assertIdentityOnEveryPath(sections, AppError),
      /Every possible form path must include/
  );
});

test('Other answers are retained only when the Other option is selected', () => {
  const form = {
    sections: [{
      id: 'registration',
      title: 'Registration',
      fields: [
        { id: 'full_name', label: 'Full Name', type: 'TextInput', required: true },
        { id: 'email', label: 'Email', type: 'TextInput', required: true },
        {
          id: 'topic',
          label: 'Topic',
          type: 'Dropdown',
          required: true,
          options: ['Other', 'Robotics']
        }
      ]
    }]
  };
  const result = validateSubmissionAnswers(
      form,
      {
        full_name: 'Ada',
        email: 'ada@example.com',
        topic: 'Other'
      },
      { topic: ' Custom topic ' }
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.otherAnswers, { topic: 'Custom topic' });
});

test('legacy flat form documents migrate to sections and keep flat JSON fields', async () => {
  const form = new Form({
    fields: requiredIdentity,
    createdBy: new mongoose.Types.ObjectId(),
    startDate: new Date(),
    endDate: new Date(Date.now() + 60_000)
  });

  await form.validate();
  const json = form.toJSON();

  assert.equal(form.sections.length, 1);
  assert.equal(form.sections[0].id, 'registration');
  assert.equal(json.fields.length, 2);
});
