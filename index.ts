import { URLSearchParams } from 'url'
import fetch from 'node-fetch'
import { Client, Intents, MessageEmbed, Channel } from 'discord.js'
import { FixedNumber, providers, utils } from 'ethers'

const { commify, formatUnits } = utils

type Log = string[]
const separator = '-'.repeat(60)

const {
  DISCORD_TOKEN,
  OPENSEA_API_TOKEN,
  INFURA_PROJECT_ID,
  TOKEN_NAME,
  TOKEN_ADDRESS,
  MIN_TOKEN_ID,
  MAX_TOKEN_ID,
  RANDOM_INTERVALS,
  DEBUG,
  CUSTOM_DESCRIPTION,
} = process.env

/**
 * Formats amount, decimals, and symbols to final string output.
 */
export const formatAmount = (
  amount: number,
  decimals: number,
  symbol: string
) => {
  let value = formatUnits(amount, decimals)
  const split = value.split('.')
  if (split[1].length > 4) {
    // Trim to 4 decimals max
    value = `${split[0]}.${split[1].slice(0, 5)}`
  } else if (split[1] === '0') {
    // If whole number remove '.0'
    value = split[0]
  }
  return `${value} ${symbol}`
}

/**
 * Formats price and usdPrice to final string output.
 */
export const formatUSD = (price: string, usdPrice: string) => {
  let value = commify(
    FixedNumber.from(price.split(' ')[0])
      .mulUnsafe(FixedNumber.from(usdPrice))
      .toUnsafeFloat()
      .toFixed(2)
  )
  // Format to 2 decimal places e.g. $1.3 -> $1.30
  if (value.split('.')[1].length === 1) {
    value = `${value}0`
  }
  return value
}

/**
 * Returns a shortened version of a full ethereum address
 * (e.g. 0x38a16…c7eb3)
 */
const shortAddr = (addr: string) => addr.slice(0, 7) + '…' + addr.slice(37, 42)

/**
 * Returns a random number specified by params, min and mix included.
 */
const random = (min = Number(MIN_TOKEN_ID), max = Number(MAX_TOKEN_ID)) =>
  Math.floor(Math.random() * (max - min + 1) + min)

/**
 * OpenSea
 */
const opensea = {
  getOpts: {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-API-KEY': OPENSEA_API_TOKEN },
  } as any,
  api: 'https://api.opensea.io/api/v1/',
  collection: `https://opensea.io/assets/${TOKEN_ADDRESS}`,
  assets: () => `${opensea.api}assets/`,
  asset: (tokenId: number) =>
    `${opensea.api}asset/${TOKEN_ADDRESS}/${tokenId}/`,
  user: (username: string) => `${opensea.api}user/${username}/`,
  offers: (tokenId: number) => `${opensea.asset(tokenId)}offers`,
  listings: (tokenId: number) => `${opensea.asset(tokenId)}listings`,
}

const addrForOpenseaUsername = async (username: string, log: Log) => {
  log.push(`Fetching OpenSea username: ${username}`)
  try {
    const response = await fetch(opensea.user(username), opensea.getOpts)
    if (!response.ok) {
      log.push(
        `Fetch Error - ${response.status}: ${response.statusText}`,
        DEBUG === 'true'
          ? `DEBUG: ${JSON.stringify(await response.text())}`
          : ''
      )
      return
    }
    const user = await response.json()
    if (!user.account?.address) {
      log.push('Skipping, no user found')
      return
    }
    return user.account.address
  } catch (error) {
    log.push(`Fetch Error: ${error?.message ?? error}`)
  }
}

const imageForAsset = (asset: any) => {
  return asset.image_url.replace(/w=(\d)*/, 'w=1000')
}

const sortPriceASC = (a: any, b: any) => {
  const usdPrice = (order: any) => {
    const { base_price, payment_token_contract } = order
    const { decimals, symbol, usd_price } = payment_token_contract
    const price = formatAmount(base_price, decimals, symbol)
    const usdPrice = formatUSD(price, usd_price)
    return Number(usdPrice.replace(/,/g, ''))
  }
  return usdPrice(a) - usdPrice(b)
}

/**
 * Fetch functions
 */
const fetchAsset = async (tokenId: number, log: Log): Promise<any> => {
  log.push(`Fetching #${tokenId}…`)
  try {
    const response = await fetch(opensea.asset(tokenId), opensea.getOpts)
    if (!response.ok) {
      log.push(
        `Fetch Error - ${response.status}: ${response.statusText}`,
        DEBUG === 'true'
          ? `DEBUG: ${JSON.stringify(await response.text())}`
          : ''
      )
      return
    }
    const asset = await response.json()
    if (!asset.token_id) {
      log.push('Skipping, no asset found')
      return
    }
    return asset
  } catch (error) {
    log.push(`Fetch Error: ${error?.message ?? error}`)
  }
}

const fetchRandomAssetByAddr = async (addr: string, log: Log) => {
  const params = new URLSearchParams({
    asset_contract_address: TOKEN_ADDRESS,
    owner: addr,
  } as any)
  log.push(`Fetching random asset owned by: ${addr}`)
  try {
    const response = await fetch(
      `${opensea.assets()}?${params}`,
      opensea.getOpts
    )
    if (!response.ok) {
      log.push(
        `Fetch Error - ${response.status}: ${response.statusText}`,
        DEBUG === 'true'
          ? `DEBUG: ${JSON.stringify(await response.text())}`
          : ''
      )
      return
    }
    const { assets } = await response.json()
    if (!assets || assets.length === 0) {
      log.push(`Skipping, no tokens found for address ${addr}`)
      return
    }
    const rand = random(0, assets.length - 1)
    return Number(assets[rand].token_id)
  } catch (error) {
    log.push(`Fetch Error: ${error?.message ?? error}`)
  }
}

const fetchHighestOffer = async (
  tokenId: number,
  owner: string,
  log: Log
): Promise<any> => {
  try {
    const url = opensea.offers(tokenId)
    const response = await fetch(url, opensea.getOpts)
    if (!response.ok) {
      log.push(
        `Fetch Error (Offers) - ${response.status}: ${response.statusText}`,
        DEBUG === 'true'
          ? `DEBUG: ${JSON.stringify(await response.text())}`
          : ''
      )
      return
    }
    const result = await response.json()
    return result.offers
      ?.sort(sortPriceASC)
      .reverse()
      .find((o: any) => o.maker.address !== owner)
  } catch (error) {
    log.push(`Fetch Error (Offers): ${error?.message ?? error}`)
  }
}

const fetchLowestListing = async (
  tokenId: number,
  owner: string,
  log: Log
): Promise<any> => {
  try {
    const url = opensea.listings(tokenId)
    const response = await fetch(url, opensea.getOpts)
    if (!response.ok) {
      log.push(
        `Fetch Error (Listings) - ${response.status}: ${response.statusText}`,
        DEBUG === 'true'
          ? `DEBUG: ${JSON.stringify(await response.text())}`
          : ''
      )
      return
    }
    const result = await response.json()
    return result.listings
      ?.sort(sortPriceASC)
      .find((l: any) => l.maker.address === owner)
  } catch (error) {
    log.push(`Fetch Error (Listings): ${error?.message ?? error}`)
  }
}

/**
 * ENS
 */
const provider = new providers.InfuraProvider('mainnet', INFURA_PROJECT_ID)

const addrForENSName = async (name: string, log: Log) => {
  log.push(`Fetching ens name: ${name}`)
  const result = await provider.resolveName(name)
  if (!result) {
    log.push(`Skipping, no address found for ${name}`)
    return
  }
  return result
}

/**
 * Discord MessageEmbed
 */
const messageEmbed = async (tokenId: number, log: Log) => {
  if (
    tokenId < Number(MIN_TOKEN_ID) ||
    tokenId > Number(MAX_TOKEN_ID) ||
    Number.isNaN(tokenId)
  ) {
    log.push(`Skipping, cannot process #${tokenId}`)
    return
  }

  const fields: any[] = []
  const asset = await fetchAsset(tokenId, log)
  if (!asset) return

  // Format owner
  const { owner } = asset.top_ownerships[0]
  const name = owner.user?.username ?? shortAddr(owner.address)
  fields.push({
    name: 'Owner',
    value: name,
    inline: true,
  })

  // Format last sale
  if (asset.last_sale) {
    const { total_price, payment_token } = asset.last_sale
    const { decimals, symbol, usd_price } = payment_token
    const price = formatAmount(total_price, decimals, symbol)
    const usdPrice = formatUSD(price, usd_price)
    const lastSale = `${price} ($${usdPrice} USD)`
    fields.push({
      name: 'Last Sale',
      value: lastSale,
      inline: true,
    })
  }

  // Format lowest list price
  const listing = await fetchLowestListing(tokenId, owner.address, log)
  if (listing) {
    const { base_price, payment_token_contract, closing_extendable } = listing
    const { decimals, symbol, usd_price } = payment_token_contract
    const price = formatAmount(base_price, decimals, symbol)
    const usdPrice = formatUSD(price, usd_price)
    const listedFor = `${price} ($${usdPrice} USD)`
    fields.push({
      name: closing_extendable ? 'Auction' : 'Listed For',
      value: listedFor,
      inline: true,
    })
  }

  // Format highest offer
  const offer = await fetchHighestOffer(tokenId, owner.address, log)
  if (offer) {
    const { base_price, payment_token_contract } = offer
    const { decimals, symbol, usd_price } = payment_token_contract
    const price = formatAmount(base_price, decimals, symbol)
    const usdPrice = formatUSD(price, usd_price)
    const highestOffer = `${price} ($${usdPrice} USD)`
    fields.push({
      name: 'Highest Offer',
      value: highestOffer,
      inline: true,
    })
  }

  // Format custom description
  const description = (CUSTOM_DESCRIPTION ?? '').replace(
    '{id}',
    tokenId.toString()
  )

  return new MessageEmbed()
    .setColor('#5296d5')
    .setTitle(`${TOKEN_NAME} #${tokenId}`)
    .setURL(asset.permalink)
    .setFields(fields)
    .setImage(imageForAsset(asset))
    .setDescription(description)
}

const matches = async (message: any, log: Log) => {
  const matches = []
  const regex = /#(random|rand|\?|\d*|[\w.\-]*.eth|[\w.\-]*)(\s|\n|\W|$)/g
  let match = regex.exec(message.content)
  if (match !== null) {
    log.push(
      `${TOKEN_NAME} - Message from ${message.author.username} in #${
        message.channel?.name ?? message.channelId
      }:\n> ${message.content}`
    )
  }
  while (match !== null) {
    const id = match[1]
    if (id === 'random' || id === 'rand' || id === '?') {
      // matches: 'random' or 'rand' or '?'
      matches.push(random())
    } else if (/^[0-9]+/.test(id)) {
      // matches: number digits (token id)
      matches.push(Number(id))
    } else if (/\w*\.eth/.test(id)) {
      // matches: .eth name
      const addr = await addrForENSName(id, log)
      if (addr) {
        const tokenId = await fetchRandomAssetByAddr(addr, log)
        if (tokenId) matches.push(tokenId)
      }
    } else if (/\w*/.test(id)) {
      // matches: opensea username
      const addr = await addrForOpenseaUsername(id, log)
      if (addr) {
        const tokenId = await fetchRandomAssetByAddr(addr, log)
        if (tokenId) matches.push(tokenId)
      }
    } else {
      log.push(`Skipping, could not understand input: ${id}`)
    }
    match = regex.exec(message.content)
  }
  return matches
}

const channelName = (channel: Channel | any) => {
  return channel.name ?? channel.channelId
}

const sendMessage = async (channel: Channel | any, embed: MessageEmbed) => {
  await channel.send({ embeds: [embed] })
}

const setupRandomIntervals = async (client: Client) => {
  if (!RANDOM_INTERVALS) return
  const intervals = RANDOM_INTERVALS.split(',')
  for (const interval of intervals) {
    const [channelId, minutesStr] = interval.split('=')
    const minutes = Number(minutesStr)
    const channel = await client.channels.fetch(channelId)
    const chanName = channelName(channel)
    console.log(
      `Sending random token every ${
        minutes === 1 ? 'minute' : `${minutes} minutes`
      } to #${chanName}`
    )
    console.log(separator)
    setInterval(async () => {
      const tokenId = random()
      const log: Log = []
      const embed = await messageEmbed(tokenId, log)
      log.push(`Sending random token to #${chanName}`)
      await sendMessage(channel, embed)
      if (log.length > 0) {
        log.push(separator)
        for (const l of log) {
          console.log(l)
        }
      }
    }, minutes * 60 * 1000)
  }
}

async function main() {
  const client = new Client({
    intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES],
    partials: ['MESSAGE'],
  })

  client.on('ready', async () => {
    console.log(separator)
    console.log(`Logged in as ${client?.user?.tag}!`)
    console.log('Listening for messages…')
    console.log(separator)
    await setupRandomIntervals(client)
  })

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return

    const log: Log = []
    try {
      const tokenIds = await matches(message, log)

      const embeds = []
      let embedLog = 'Replied with'

      for (const tokenId of tokenIds.slice(0, 5)) {
        const embed = await messageEmbed(tokenId, log)
        if (embed) {
          embeds.push(embed)
          embedLog += ` #${tokenId}`
        }
      }
      if (embeds.length > 0) {
        await message.reply({ embeds })
        log.push(embedLog)
      }
    } catch (error) {
      log.push(`Error: ${error}`)
    }
    if (log.length > 0) {
      log.push(separator)
      for (const l of log) {
        console.log(l)
      }
    }
  })

  /**
   * Start
   */
  client.login(DISCORD_TOKEN)
}

main()
