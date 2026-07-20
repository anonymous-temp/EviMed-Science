package com.sentum.evidencecomprehensive.domain.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.ArrayList;
import java.util.List;

/**
 * 同义词反馈存储
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_synonym_feedback")
public class SynonymFeedback {
    @Id
    private String id;
    /**
     * 用户输入词
     */
    private String word;
    /**
     * 中文同义词
     */
    private List<WordStatus> zhSynonym = new ArrayList<>();
    /**
     * 英文同义词
     */
    private List<WordStatus> enSynonym = new ArrayList<>();
    /**
     * 用户id
     */
    private Long userId;
}
