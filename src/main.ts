import {
	moment,
	CachedMetadata,
	Plugin,
	TFile,
	TAbstractFile,
	getAllTags,
	Notice,
	HeadingCache,
} from "obsidian";
import {
	ListModifiedSettings,
	DEFAULT_SETTINGS,
	ListModifiedSettingTab,
} from "./settings";
import { serialize } from "monkey-around";
import {
	createDailyNote,
	getAllDailyNotes,
	getDailyNote,
	getDailyNoteSettings,
} from "obsidian-daily-notes-interface";
import { z } from "zod";

export default class ListModified extends Plugin {
	settings: ListModifiedSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		const schema = z.preprocess(
			(a) => parseInt(a as string, 10),
			z.number().positive()
		);

		// if interval is 0, don't run the registerInterval and instead just run on modify.
		const defaultWriteInterval = DEFAULT_SETTINGS.writeInterval;
		let writeIntervalSec = parseInt(defaultWriteInterval);
		try {
			writeIntervalSec = schema.parse(this.settings.writeInterval);
		} catch (error) {
			this.displayNotice(
				"Invalid write interval. Defaulting to " +
					defaultWriteInterval +
					" seconds."
			);
		}

		this.registerInterval(
			window.setInterval(
				() => console.log("test"),
				writeIntervalSec * 1000
			)
		);

		this.registerEvent(
			this.app.metadataCache.on("changed", this.onCacheChange)
		);

		this.registerEvent(this.app.vault.on("delete", this.onVaultDelete));
		this.registerEvent(this.app.vault.on("rename", this.onVaultRename));

		this.addSettingTab(new ListModifiedSettingTab(this.app, this));
	}

	private onCacheChange = serialize(
		async (file: TFile, _data: string, cache: CachedMetadata) => {
			const trackedFiles = this.settings.trackedFiles;
			const currentDate = moment().format("YYYY-MM-DD");

			if (this.settings.lastTrackedDate !== currentDate) {
				this.settings.trackedFiles = [];
				this.settings.lastTrackedDate = currentDate;
			}

			const path: string = file.path;

			if (file === getDailyNote(moment(), getAllDailyNotes())) {
				return;
			}

			// make shift set
			if (
				!trackedFiles.includes(path) &&
				!this.cacheContainsIgnoredTag(cache) &&
				!this.pathIsExcluded(path) &&
				!this.noteTitleContainsIgnoredText(file.basename)
			) {
				trackedFiles.push(path);
			}

			if (
				(trackedFiles.includes(path) &&
					this.cacheContainsIgnoredTag(cache)) ||
				this.pathIsExcluded(path) ||
				this.noteTitleContainsIgnoredText(file.basename)
			) {
				trackedFiles.remove(path);
			}

			await this.updateTrackedFiles();
		}
	);

	private noteTitleContainsIgnoredText(noteTitle: string): boolean {
		const ignoredText = this.settings.ignoredNameContains
			.replace(/\s/g, "")
			.split(",");

		return ignoredText.some((ignoredText: string) =>
			noteTitle.toLowerCase().includes(ignoredText.toLowerCase())
		);
	}

	private cacheContainsIgnoredTag(cache: CachedMetadata): boolean {
		const currentFileTags: string[] = getAllTags(cache);
		const ignoredTags = this.settings.tags.replace(/\s/g, "").split(",");
		return ignoredTags.some((ignoredTag: string) =>
			currentFileTags.includes(ignoredTag)
		);
	}

	private pathIsExcluded(path: string): boolean {
		const excludedFolders = this.settings.excludedFolders;
		if (!excludedFolders) return false;
		const excludedFolderPaths: string[] = excludedFolders
			.replace(/\s*, | \s*,/, ",")
			.split(",")
			.map((item) => item.replace(/^\/|\/$/g, ""));

		const currentFilePath: string =
			this.app.vault.getAbstractFileByPath(path).parent.path;

		return excludedFolderPaths.some((excludedFolder: string) =>
			currentFilePath.startsWith(excludedFolder)
		);
	}

	private onVaultDelete = serialize(async (file: TAbstractFile) => {
		if (file instanceof TFile) {
			if (this.settings.trackedFiles.includes(file.path)) {
				this.settings.trackedFiles.remove(file.path);
				await this.updateTrackedFiles();
			}
		}
	});

	private onVaultRename = serialize(
		async (file: TAbstractFile, oldPath: string) => {
			if (file instanceof TFile) {
				if (this.settings.trackedFiles.includes(oldPath)) {
					this.settings.trackedFiles.remove(oldPath);
					this.settings.trackedFiles.push(file.path);

					await this.saveSettings();
					// obsidian already handles link renames
					if (!this.settings.outputFormat.includes("[[link]]")) {
						await this.updateTrackedFiles();
					}
				}
			}
		}
	);

	updateTrackedFiles = serialize(async () => {
		await this.saveSettings();

		let dailyNote: TFile;

		try {
			dailyNote = getDailyNote(moment(), getAllDailyNotes());
		} catch (e) {
			this.displayNotice(
				"Unable to load daily note. See console for details."
			);
			console.log(e.message);
		}

		// TEMP FOR MIGRATION FROM 1.0 TO 2.0!
		const backupPath =
			getDailyNoteSettings().folder +
			moment().format(getDailyNoteSettings().format) +
			"-BACKUP.md";

		if (dailyNote && !this.settings.hasBeenBackedUp) {
			this.displayNotice(
				"Your daily note for today has been backed up to " +
					backupPath +
					". " +
					"This is for users who have migrated to OLM 2.0 so that their daily " +
					"note content is not lost. Feel free to delete the backup file or port its content " +
					"to the new one. This message will not be shown to you again. " +
					"This is a one-time process. If you were not a 1.0 user, disregard this."
			);
			this.app.vault.copy(dailyNote, backupPath);
			this.settings.hasBeenBackedUp = true;
			this.saveSettings();
		}

		if (!dailyNote && this.settings.automaticallyCreateDailyNote) {
			this.displayNotice("Creating daily note since it did not exist...");
			dailyNote = await createDailyNote(moment());
		}

		if (dailyNote) {
			const cache: CachedMetadata =
				this.app.metadataCache.getFileCache(dailyNote);
			const headings: HeadingCache[] = cache.headings;
			// this.app.vault.modify(dailyNote, .join('\n'));
			let content: string[] = (
				await this.app.vault.read(dailyNote)
			).split("\n");

			if (!headings || !this.settings.heading) {
				this.displayNotice(
					"Cannot create list. Please read the Obsidian List Modified 'Headings' settings."
				);
				return;
			}

			for (let i = 0; i < headings.length; i++) {
				if (headings[i].heading === this.settings.heading) {
					const startPos: number = headings[i].position.end.line + 1;
					if (headings[i + 1]) {
						const endPos: number =
							headings[i + 1].position.start.line - 1;
						content.splice(
							startPos,
							endPos - startPos,
							...this.settings.trackedFiles.map((path) =>
								this.getFormattedOutput(path)
							)
						);
					} else {
						const endPos: number = content.length;
						content.splice(
							startPos,
							endPos - startPos,
							...this.settings.trackedFiles.map((path) =>
								this.getFormattedOutput(path)
							)
						);
					}

					this.app.vault.modify(dailyNote, content.join("\n"));
					return;
				}
			}

			this.displayNotice(
				"Cannot create list. Please read the Obsidian List Modified settings."
			);
		}
	});

	private getFormattedOutput(path: string): string {
		const file: TFile = this.app.vault.getAbstractFileByPath(path) as TFile;
		return this.settings.outputFormat
			.replace(
				"[[link]]",
				this.app.fileManager.generateMarkdownLink(
					file,
					getDailyNote(moment(), getAllDailyNotes()).path
				)
			)
			.replace("[[name]]", file.basename)
			.replace(
				"[[tags]]",
				getAllTags(this.app.metadataCache.getFileCache(file))
					.map((tag) => "\\" + tag)
					.join(", ")
			)
			.replace("[[ctime]]", moment(file.stat.ctime).format("YYYY-MM-DD"));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	public displayNotice(message: string) {
		new Notice("[Obsidian List Modified] " + message);
	}
}
