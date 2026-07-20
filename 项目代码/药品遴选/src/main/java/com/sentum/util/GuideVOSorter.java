package com.sentum.util;

import com.sentum.pojo.vo.GuideVO;

import java.util.*;
import java.util.stream.Collectors;

public class GuideVOSorter {

    /**
     * 对GuideVO列表进行排序
     * @param guideList 待排序的GuideVO列表
     * @param titleOrderList1 第一个标题顺序列表
     * @param titleOrderList2 第二个标题顺序列表
     * @return 排序后的列表
     */
    public static List<GuideVO> sortGuideVOList(List<GuideVO> guideList, List<String> titleOrderList1, List<String> titleOrderList2) {
        if (guideList == null) {
            return guideList;
        }

        // 创建映射，用于快速查找title在各列表中的索引
        Map<String, Integer> titleIndexMap1 = new HashMap<>();
        Map<String, Integer> titleIndexMap2 = new HashMap<>();

        for (int i = 0; i < titleOrderList1.size(); i++) {
            titleIndexMap1.put(titleOrderList1.get(i), i);
        }

        for (int i = 0; i < titleOrderList2.size(); i++) {
            titleIndexMap2.put(titleOrderList2.get(i), i);
        }

        return guideList.stream()
                .sorted((guide1, guide2) -> {
                    // 首先按scorex排序
                    int scorexCompare = compareScorex(guide1.getScorex(), guide2.getScorex());
                    if (scorexCompare != 0) {
                        return scorexCompare;
                    }

                    // scorex相同时，按标题在两个列表中的出现情况进行排序
                    return compareTitlePriority(guide1.getTitle(), guide2.getTitle(), titleIndexMap1, titleIndexMap2);
                })
                .collect(Collectors.toList());
    }

    /**
     * 比较两个scorex值
     * @param scorex1 第一个scorex
     * @param scorex2 第二个scorex
     * @return 比较结果
     */
    private static int compareScorex(String scorex1, String scorex2) {
        if (scorex1 == null && scorex2 == null) return 0;
        if (scorex1 == null) return 1; // null值排在后面
        if (scorex2 == null) return -1;

        try {
            double s1 = Double.parseDouble(scorex1);
            double s2 = Double.parseDouble(scorex2);
            return Double.compare(s2, s1); // 降序排列，分数高的在前
        } catch (NumberFormatException e) {
            return scorex1.compareTo(scorex2);
        }
    }

    /**
     * 根据标题在两个列表中的出现情况和顺序进行优先级排序
     * @param title1 第一个标题
     * @param title2 第二个标题
     * @param titleIndexMap1 第一个列表的索引映射
     * @param titleIndexMap2 第二个列表的索引映射
     * @return 比较结果
     */
    private static int compareTitlePriority(String title1, String title2, Map<String, Integer> titleIndexMap1, Map<String, Integer> titleIndexMap2) {
        // 获取每个标题在两个列表中的优先级信息
        TitlePriority priority1 = getTitlePriority(title1, titleIndexMap1, titleIndexMap2);
        TitlePriority priority2 = getTitlePriority(title2, titleIndexMap1, titleIndexMap2);

        // 按优先级排序
        if (priority1.priorityLevel != priority2.priorityLevel) {
            return Integer.compare(priority1.priorityLevel, priority2.priorityLevel);
        }

        // 在同一优先级内，按对应列表中的顺序排序
        switch (priority1.priorityLevel) {
            case 1: // 同时出现在两个列表中
            case 2: // 只出现在第一个列表中
                return Integer.compare(priority1.indexInList1, priority2.indexInList1);
            case 3: // 只出现在第二个列表中
                return Integer.compare(priority1.indexInList2, priority2.indexInList2);
            default: // 都不在列表中，按字典序排序
                return title1.compareTo(title2);
        }
    }

    /**
     * 获取标题的优先级信息
     * @param title 标题
     * @param titleIndexMap1 第一个列表的索引映射
     * @param titleIndexMap2 第二个列表的索引映射
     * @return 标题优先级信息
     */
    private static TitlePriority getTitlePriority(String title, Map<String, Integer> titleIndexMap1, Map<String, Integer> titleIndexMap2) {
        if (title == null) {
            return new TitlePriority(4, Integer.MAX_VALUE, Integer.MAX_VALUE);
        }

        // 查找在两个列表中的索引（支持模糊匹配）
        Integer index1 = findTitleIndex(title, titleIndexMap1);
        Integer index2 = findTitleIndex(title, titleIndexMap2);

        // 确定优先级级别
        if (index1 != null && index2 != null) {
            // 同时出现在两个列表中 - 第一优先级
            return new TitlePriority(1, index1, index2);
        } else if (index1 != null) {
            // 只出现在第一个列表中 - 第二优先级
            return new TitlePriority(2, index1, Integer.MAX_VALUE);
        } else if (index2 != null) {
            // 只出现在第二个列表中 - 第三优先级
            return new TitlePriority(3, Integer.MAX_VALUE, index2);
        } else {
            // 都不在列表中 - 第四优先级
            return new TitlePriority(4, Integer.MAX_VALUE, Integer.MAX_VALUE);
        }
    }

    /**
     * 查找title在titleOrder中的索引（支持模糊匹配）
     * @param title 要查找的title
     * @param titleIndexMap title索引映射
     * @return 索引或null
     */
    private static Integer findTitleIndex(String title, Map<String, Integer> titleIndexMap) {
        // 精确匹配
        if (titleIndexMap.containsKey(title)) {
            return titleIndexMap.get(title);
        }

        // 模糊匹配：检查title是否包含titleOrder中的某个字符串
        for (Map.Entry<String, Integer> entry : titleIndexMap.entrySet()) {
            if (title.contains(entry.getKey())) {
                return entry.getValue();
            }
        }

        return null;
    }

    /**
     * 标题优先级信息类
     */
    private static class TitlePriority {
        // 优先级级别：1-同时出现在两个列表中，2-只出现在第一个列表中，3-只出现在第二个列表中，4-都不在列表中
        final int priorityLevel;
        // 在第一个列表中的索引
        final int indexInList1;
        // 在第二个列表中的索引
        final int indexInList2;

        TitlePriority(int priorityLevel, int indexInList1, int indexInList2) {
            this.priorityLevel = priorityLevel;
            this.indexInList1 = indexInList1;
            this.indexInList2 = indexInList2;
        }
    }
}
