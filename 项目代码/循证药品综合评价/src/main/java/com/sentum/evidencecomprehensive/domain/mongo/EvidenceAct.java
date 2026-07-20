package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * act药品等级数据
 * @author zgm
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Document("evidence_act")
public class EvidenceAct {
    @Id
    private String id;
    /**
     * 当前节点的词-中文
     */
    private String zhWord;
    /**
     * 当前节点的词-英文
     */
    private String enWord;
    /**
     * 同义词
     */
    private List<String> synonym;
    /**
     * 当前节点的编码 ***.***.***.***.***
     */
    private String code;
    /**
     * 当前节点所处等级（即 . 的数量）
     */
    private Integer codeLevel;
}
