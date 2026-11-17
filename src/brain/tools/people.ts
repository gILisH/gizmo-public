import { tool } from 'ai'
import { z } from 'zod'
import type { BrainDeps, ToolCtx } from '../types'
import { REL_TYPES } from '../../people'

// The face-library tools (all owner-only): enroll, compose a scene, place saved faces into
// a photo, curate/delete photos, unify names, record family edges. Execute logic lives in
// media/tools (makePeopleImageTools) + people/; these are the model-facing schemas.
// A guest group gets only create_scene + place_into_photo, for every member, drawing on the
// group's own library (app.ts peopleFor). Saving/curating faces stays owner-only.
export function peopleTools(deps: BrainDeps, id: string, ctx: ToolCtx) {
  if (!ctx.isOwner && !ctx.guest) return {}
  const all = {
    ...(deps.enrollPerson
      ? {
          enroll_person: tool({
            description:
              'Save the photo(s) the owner just sent as a known PERSON, so you can place them in AI scenes later (create_scene). Use when the owner says "this is Itai", "save these as savta", "remember what Dad looks like". Capture aliases (nicknames like "savta"/"סבתא") and relation ("Alex\'s mom", "Itai\'s dad") when they say them. If a person with the same first name already exists, the tool asks you to confirm same-person-or-new: relay that; if the owner says SAME, re-call using the existing person\'s FULL name; if the owner says NEW, re-call with force_new:true. Uses the most recent photo(s) in this chat. Owner-only.',
            inputSchema: z.object({
              name: z.string().describe("the person's name"),
              aliases: z.array(z.string()).optional().describe('nicknames they go by (savta, סבתא, dad, …)'),
              relation: z.string().optional().describe('who they are relative to the family: "Alex\'s mom", "Itai\'s dad"'),
              force_new: z.boolean().optional().describe('set true ONLY after the owner confirmed this is a NEW person despite a name clash'),
            }),
            execute: async ({ name, aliases, relation, force_new }) => deps.enrollPerson!(ctx.chatJid ?? id, name, { aliases, relation, forceNew: force_new }),
          }),
        }
      : {}),
    ...(deps.composeScene
      ? {
          create_scene: tool({
            description:
              'Create an AI image placing KNOWN people (from your People roster) into a scene — "put Itai and his dad with savta on the moon". First resolve every name/relation to the roster names, then pass those names. `scene` describes the setting/action ("standing on the moon in spacesuits"). If a named person isn\'t in the roster, DON\'T call this — tell them you need their photos first.',
            inputSchema: z.object({
              people: z.array(z.string()).min(1).describe('resolved roster names of the people to place (e.g. ["Itai","Omer","Tova"])'),
              scene: z.string().describe('the scene/setting/action (English works best)'),
            }),
            execute: async ({ people, scene }) => deps.composeScene!(ctx.chatJid ?? id, people, scene),
          }),
        }
      : {}),
    ...(deps.placeIntoPhoto
      ? {
          place_into_photo: tool({
            description:
              'Add one or more people who are in your SAVED People roster (real faces) INTO the photo just sent in this chat — base photo + saved reference faces. Use ONLY for people whose photos you actually have saved: "add my mom to this", "put savta next to the kids", "add Ruth here". For a FAMOUS person or anyone NOT in your roster, do NOT use this and do NOT say you can\'t — use edit_image and describe them ("add Madonna"), since you generate famous faces from the description. This is DIFFERENT from create_scene (generates a scene from scratch, no base photo). Resolve names to the roster first; needs a recent photo as the base.',
            inputSchema: z.object({
              people: z.array(z.string()).min(1).describe('roster names of the people to add into the photo'),
              instruction: z.string().describe('what to do, e.g. "add her standing next to the two kids" (English works best)'),
            }),
            execute: async ({ people, instruction }) => deps.placeIntoPhoto!(ctx.chatJid ?? id, people, instruction),
          }),
        }
      : {}),
    ...(deps.forgetPerson
      ? {
          forget_person: tool({
            description:
              'Delete a known person and ALL their saved photos from your People roster. Use when the owner says "remove/forget/delete <name>", "delete my photos", "forget savta". Resolve the name/alias to a roster person first. This is permanent.',
            inputSchema: z.object({ name: z.string().describe('the person to remove (name or alias from the roster)') }),
            execute: async ({ name }) => deps.forgetPerson!(name),
          }),
        }
      : {}),
    ...(deps.showPersonPhotos
      ? {
          show_person_photos: tool({
            description:
              'Send back ALL saved photos of a known person, each numbered (1/N, 2/N…), so the owner can see what you have and decide which to delete. Use when the owner says "show me <name>\'s photos", "which photos do you have of savta", "let me see the pics of Itai". Resolve the name/alias to a roster person first.',
            inputSchema: z.object({ name: z.string().describe('the person whose photos to show (name or alias)') }),
            execute: async ({ name }) => deps.showPersonPhotos!(ctx.chatJid ?? id, name),
          }),
        }
      : {}),
    ...(deps.deletePersonPhoto
      ? {
          delete_person_photo: tool({
            description:
              'Delete ONE saved photo of a person by its shown number. Use after show_person_photos when the owner says "delete 2", "remove photo 3 of Itai", "the first one is bad". Pass the person + the 1-based number as it was shown. To delete the whole person use forget_person instead.',
            inputSchema: z.object({
              name: z.string().describe('the person (name or alias from the roster)'),
              position: z.number().int().min(1).describe('the 1-based photo number as it was shown'),
            }),
            execute: async ({ name, position }) => deps.deletePersonPhoto!(name, position),
          }),
        }
      : {}),
    ...(deps.addPersonNames
      ? {
          add_name: tool({
            description:
              'Add extra names/nicknames to a person ALREADY in the roster, so they all resolve to the same person — use when the owner says "savta ruth is also called mum", "רות זה גם אמא", "he also goes by X". Pass the existing person (any current name) + the new names to add.',
            inputSchema: z.object({
              name: z.string().describe('an existing name of the person'),
              extra: z.array(z.string()).min(1).describe('the additional names/nicknames to add'),
            }),
            execute: async ({ name, extra }) => deps.addPersonNames!(name, extra),
          }),
        }
      : {}),
    ...(deps.setPersonRelation
      ? {
          set_relation: tool({
            description:
              'Record a FAMILY relationship between two people in the roster, phrased as "<person> is the <relation> of <of>". Use when the owner states a relation ("רות היא אמא של דני" → person=רות, relation=mother, of=דני; "ליה היא הבת של שירה" → person=ליה, relation=child, of=שירה). This lets you resolve speaker-relative kinship terms later ("אמא" means different people to different speakers). The inverse is stored automatically. Both people must already be in the roster.',
            inputSchema: z.object({
              person: z.string().describe('the person who IS the relation'),
              relation: z.enum(REL_TYPES),
              of: z.string().describe('whose <relation> they are'),
            }),
            execute: async ({ person, relation, of }) => deps.setPersonRelation!(person, relation, of),
          }),
        }
      : {}),
    ...(deps.setPersonHeight
      ? {
          set_height: tool({
            description:
              'Save a person\'s real HEIGHT in cm (e.g. "אלכס גובהו 173", "Omer is 135cm"). Do this whenever the owner tells you someone\'s height. You then use everyone\'s stored heights to keep RELATIVE sizes right in generated scenes — so ask for heights once when a family scene comes out with wrong proportions. Don\'t put raw cm numbers in image prompts yourself; just save them here and the scene tools handle the proportions.',
            inputSchema: z.object({
              name: z.string().describe('the person (name or alias from the roster)'),
              cm: z.number().int().min(30).max(250).describe('height in centimeters'),
            }),
            execute: async ({ name, cm }) => deps.setPersonHeight!(name, cm),
          }),
        }
      : {}),
  }
  if (!ctx.guest) return all
  const { create_scene, place_into_photo } = all as Partial<typeof all & Record<'create_scene' | 'place_into_photo', unknown>>
  return { ...(create_scene ? { create_scene } : {}), ...(place_into_photo ? { place_into_photo } : {}) }
}
