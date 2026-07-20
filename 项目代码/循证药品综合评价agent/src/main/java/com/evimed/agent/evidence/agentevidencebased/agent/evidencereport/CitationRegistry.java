package com.evimed.agent.evidence.agentevidencebased.agent.evidencereport;

import com.evimed.agent.evidence.agentevidencebased.tools.EvidenceRetrievalTool;
import lombok.extern.slf4j.Slf4j;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 文献引用注册表
 *
 * 为检索到的文献分配全局唯一编号，支持正文中使用 [N] 标记引用。
 * 最终生成参考文献列表时，按正文首次出现顺序重新编号。
 */
@Slf4j
public class CitationRegistry {

    private final Map<String, Integer> idToNum = new LinkedHashMap<>();
    private final Map<Integer, EvidenceRetrievalTool.EvidenceItem> numToItem = new LinkedHashMap<>();
    private int nextNum = 1;

    /**
     * 注册文献，返回全局编号（幂等，同一 id 返回相同编号）
     */
    public synchronized int register(EvidenceRetrievalTool.EvidenceItem item) {
        if (item == null || item.getId() == null || item.getId().isBlank()) {
            log.warn("尝试注册无效文献（id 为空），跳过");
            return -1;
        }

        String id = item.getId();
        if (idToNum.containsKey(id)) {
            return idToNum.get(id);
        }

        int num = nextNum++;
        idToNum.put(id, num);
        numToItem.put(num, item);
        log.debug("注册文献 [{}]: {}", num, item.getTitle());
        return num;
    }

    /**
     * 根据文献 id 获取编号
     */
    public Integer getNum(String id) {
        return idToNum.get(id);
    }

    /**
     * 根据编号获取文献
     */
    public EvidenceRetrievalTool.EvidenceItem getItem(int num) {
        return numToItem.get(num);
    }

    /**
     * 是否为空
     */
    public boolean isEmpty() {
        return numToItem.isEmpty();
    }

    /**
     * 文献总数
     */
    public int size() {
        return numToItem.size();
    }

    /**
     * 移除指定 ID 的文献，并重新编号（保持剩余文献的原始顺序）
     * @param idsToRemove 需要移除的文献原始 ID 集合
     * @return 移除的文献数量
     */
    public synchronized int removeByIds(Set<String> idsToRemove) {
        if (idsToRemove == null || idsToRemove.isEmpty()) return 0;

        Map<String, Integer> newIdToNum = new LinkedHashMap<>();
        Map<Integer, EvidenceRetrievalTool.EvidenceItem> newNumToItem = new LinkedHashMap<>();
        int newNum = 1;

        // 按原始注册顺序遍历，跳过需要移除的
        for (Map.Entry<String, Integer> entry : idToNum.entrySet()) {
            if (!idsToRemove.contains(entry.getKey())) {
                EvidenceRetrievalTool.EvidenceItem item = numToItem.get(entry.getValue());
                if (item != null) {
                    newIdToNum.put(entry.getKey(), newNum);
                    newNumToItem.put(newNum, item);
                    newNum++;
                }
            }
        }

        int removedCount = numToItem.size() - newNumToItem.size();
        idToNum.clear();
        numToItem.clear();
        idToNum.putAll(newIdToNum);
        numToItem.putAll(newNumToItem);
        nextNum = newNum;

        log.info("文献剔除完成：保留 {} 条，移除 {} 条", newNumToItem.size(), removedCount);
        return removedCount;
    }
}
