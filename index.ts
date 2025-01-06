import { Plugin, PluginMeta, PluginEvent, RetryError } from '@posthog/plugin-scaffold'
import { PubSub, Topic } from "@google-cloud/pubsub"

type PubSubPlugin = Plugin<{
    global: {
        pubSubClient: PubSub
        pubSubTopic: Topic
    }
    config: {
        topicId: string
    },
}>

export const setupPlugin: PubSubPlugin['setupPlugin'] = async (meta) => {
    const { global, attachments, config } = meta
    if (!attachments.googleCloudKeyJson) {
        throw new Error('JSON config not provided!')
    }
    if (!config.topicId) {
        throw new Error('Topic ID not provided!')
    }

    try {
        const credentials = JSON.parse(attachments.googleCloudKeyJson.contents.toString())
        global.pubSubClient = new PubSub({
            projectId: credentials['project_id'],
            credentials,
        })
        global.pubSubTopic = global.pubSubClient.topic(config.topicId);

        // topic exists
        await global.pubSubTopic.getMetadata()
    } catch (error: any) {
        // some other error? abort!
        if (!error.message.includes("NOT_FOUND")) {
            throw new Error(error)
        }
        console.log(`Creating PubSub Topic - ${config.topicId}`)

        try {
            await global.pubSubTopic.create()
        } catch (error: any) {
            // a different worker already created the table
            if (!error.message.includes('ALREADY_EXISTS')) {
                throw error
            }
        }
    }
}

export async function exportEvents(events: PluginEvent[], { global, config }: PluginMeta<PubSubPlugin>) {
    if (!global.pubSubClient) {
        throw new Error('No PubSub client initialized!')
    }
    try {
        const messages = events.map((fullEvent) => {
            const { event, properties, $set, $set_once, distinct_id, team_id, site_url, now, sent_at, uuid, ...rest } =
                fullEvent
            const ip = properties?.['$ip'] || fullEvent.ip
            const timestamp = fullEvent.timestamp || properties?.timestamp || now || sent_at
            let ingestedProperties = properties
            let elements = []

            // only move prop to elements for the $autocapture action
            if (event === '$autocapture' && properties?.['$elements']) {
                const { $elements, ...props } = properties
                ingestedProperties = props
                elements = $elements
            }

            const message = {
                event,
                distinct_id,
                team_id,
                ip,
                site_url,
                timestamp,
                uuid: uuid!,
                properties: ingestedProperties || {},
                elements: elements || [],
                people_set: $set || {},
                people_set_once: $set_once || {},
            }

            // Attributes to be sent with the pub/sub message
            const attributes = {
                event
            }
            return {data: Buffer.from(JSON.stringify(message)), attributes}
        })

        const start = Date.now()
        await Promise.all(
            messages.map((message) =>
                global.pubSubTopic.publishMessage(message).then((messageId) => {
                    return messageId
                })
            )
        )
        const end = Date.now() - start

        console.log(
            `Published ${events.length} ${events.length > 1 ? 'events' : 'event'} to ${config.topicId}. Took ${
                end / 1000
            } seconds.`
        )
    } catch (error: any) {
        console.error(
            `Error publishing ${events.length} ${events.length > 1 ? 'events' : 'event'} to ${config.topicId}: `,
            error
        )
        throw new RetryError(`Error publishing to Pub/Sub! ${JSON.stringify(error.errors)}`)
    }
}