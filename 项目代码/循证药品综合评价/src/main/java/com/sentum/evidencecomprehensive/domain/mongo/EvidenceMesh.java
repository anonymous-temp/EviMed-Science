package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * 英文mesh
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_mesh")
public class EvidenceMesh {
    @Id
    private String id;
    /**
     * 主题词
     */
    private String title;
    /**
     * 入口词
     */
    private List<String> entryTerms;
    /**
     * 树形结构编码
     */
    private String treeNumber;
}
