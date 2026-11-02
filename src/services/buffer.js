// Thin client for Buffer's GraphQL API (https://api.buffer.com), used by the
// buffer-publish job. AIM's channels sit in two Buffer accounts, so each
// platform names the env var holding that account's API key.
const CHANNELS = Object.freeze({
  instagram: { id: '6ad25e19778b240e2f2c4ede', keyEnv: 'BUFFER_KEY_IG_X_GBP' },
  linkedin: { id: '6ace4797778b240e2ff84576', keyEnv: 'BUFFER_KEY_LI_YT_THREADS' },
  youtube: { id: '6ace471b778b240e2ff837bf', keyEnv: 'BUFFER_KEY_LI_YT_THREADS' },
})

const API_URL = 'https://api.buffer.com'
const YOUTUBE_EDUCATION_CATEGORY = '27'

// Turns one buffer-schedule.json entry into Buffer's CreatePostInput. Pure,
// so it can be tested without calling Buffer.
function buildPostInput(entry) {
  const channel = CHANNELS[entry.platform]
  if (!channel) throw new Error(`No Buffer channel for ${entry.platform}`)
  const input = {
    channelId: channel.id,
    text: entry.text,
    schedulingType: 'automatic',
    mode: 'customScheduled',
    dueAt: entry.dueAt,
  }

  let instagramType = 'post'
  if (entry.video) {
    // Buffer rejects custom video thumbnails; Instagram uses the first frame.
    input.assets = [{ video: { url: entry.video.url } }]
    instagramType = 'reel'
  } else if (entry.document) {
    input.assets = [{ document: { url: entry.document.url, title: entry.document.title, thumbnailUrl: entry.document.thumbnailUrl || undefined } }]
  } else if (entry.images?.length) {
    const metadata = entry.altText ? { altText: entry.altText } : undefined
    // Several images make a carousel; Instagram's type stays 'post'.
    input.assets = entry.images.map((url) => ({ image: { url, metadata } }))
  } else {
    throw new Error('Entry has no image, video or document')
  }

  if (entry.platform === 'instagram') {
    input.metadata = { instagram: { type: instagramType, shouldShareToFeed: true } }
  } else if (entry.platform === 'youtube') {
    if (!entry.title) throw new Error('YouTube post has no title')
    input.metadata = { youtube: { title: entry.title.slice(0, 100), categoryId: YOUTUBE_EDUCATION_CATEGORY, privacy: 'public', madeForKids: false, notifySubscribers: true } }
  }
  return input
}

async function gql(platform, query, variables) {
  const keyEnv = CHANNELS[platform]?.keyEnv
  const key = keyEnv && process.env[keyEnv]
  if (!key) throw new Error(`${keyEnv || 'Buffer key'} is not set`)
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.errors?.length) {
    throw new Error(`Buffer API ${res.status}: ${body.errors?.[0]?.message || JSON.stringify(body).slice(0, 300)}`)
  }
  return body.data
}

async function createPost(entry) {
  const data = await gql(entry.platform, `mutation($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { id } }
      ... on MutationError { message }
    }
  }`, { input: buildPostInput(entry) })
  const result = data.createPost
  if (!result?.post?.id) throw new Error(result?.message || 'Buffer did not return a post id')
  return result.post.id
}

async function deletePost(platform, bufferPostId) {
  const data = await gql(platform, `mutation($input: DeletePostInput!) {
    deletePost(input: $input) {
      __typename
      ... on MutationError { message }
    }
  }`, { input: { id: bufferPostId } })
  if (data.deletePost?.message) throw new Error(data.deletePost.message)
}

module.exports = { CHANNELS, buildPostInput, createPost, deletePost }
