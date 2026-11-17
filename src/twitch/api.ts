const GQL_URL = 'https://gql.twitch.tv/gql';
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

export interface LiveArchive {
  videoId: string;
  recordedAt: number;
}

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Client-ID': CLIENT_ID },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GQL request failed with status ${response.status}`);
  const body: GqlResponse<T> = await response.json();
  if (body.errors?.length || !body.data) throw new Error(`GQL error: ${body.errors?.[0]?.message}`);
  return body.data;
}

interface LiveArchiveData {
  user: { stream: { archiveVideo: { id: string; recordedAt: string } | null } | null } | null;
}

export async function fetchLiveArchive(login: string): Promise<LiveArchive | null> {
  const data = await gql<LiveArchiveData>(
    'query ($login: String!) { user(login: $login) { stream { archiveVideo { id recordedAt } } } }',
    { login },
  );
  const video = data.user?.stream?.archiveVideo;
  return video ? { videoId: video.id, recordedAt: Date.parse(video.recordedAt) } : null;
}

interface PlaybackTokenData {
  videoPlaybackAccessToken: { value: string; signature: string } | null;
}

export async function resolveVodPlaylist(videoId: string): Promise<string> {
  const data = await gql<PlaybackTokenData>(
    `query ($id: ID!) {
      videoPlaybackAccessToken(id: $id, params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) {
        value
        signature
      }
    }`,
    { id: videoId },
  );
  const token = data.videoPlaybackAccessToken;
  if (!token) throw new Error(`No playback token for video ${videoId}`);

  const url = new URL(`https://usher.ttvnw.net/vod/${videoId}.m3u8`);
  url.search = new URLSearchParams({
    sig: token.signature,
    token: token.value,
    allow_source: 'true',
    allow_audio_only: 'true',
    platform: 'web',
    player_backend: 'mediaplayer',
    playlist_include_framerate: 'true',
    supported_codecs: 'h264',
  }).toString();

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Video ${videoId} is not playable: status ${response.status}`);
  return url.toString();
}
